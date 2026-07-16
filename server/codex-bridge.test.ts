import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGeneratedWorkflow } from "../src/data/seed.js";
import { CodexAppServerClient } from "./codex-app-server.js";
import { CodexBridge } from "./codex-bridge.js";
import { JsonWorkflowStore } from "./store.js";

const fixture = path.resolve(process.cwd(), "server/fixtures/fake-app-server.mjs");

describe("Codex app-server bridge", () => {
  let directory = "";
  let bridge: CodexBridge | undefined;

  afterEach(async () => {
    await bridge?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("creates native threads, streams tool and assistant events, and schedules the workflow graph", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codex-loop-bridge-"));
    const store = new JsonWorkflowStore(path.join(directory, "data.json"));
    const workflow = await store.addWorkflow(createGeneratedWorkflow("Verify the native bridge"));
    const client = new CodexAppServerClient({ command: process.execPath, args: [fixture] });
    bridge = new CodexBridge(store, client);

    await bridge.startWorkflow(workflow.id);
    const completed = await waitFor(async () => {
      const current = await store.getWorkflow(workflow.id);
      return current.status === "completed" ? current : undefined;
    });

    expect(completed.nodes.every((node) => node.status === "completed")).toBe(true);
    expect(completed.threads.every((thread) => thread.codex?.threadId?.startsWith("native-thread-"))).toBe(true);
    expect(completed.threads.every((thread) => thread.codex?.model === "fake-codex-model")).toBe(true);
    expect(completed.threads.every((thread) => thread.toolCalls.some((tool) => tool.output === "bridge-ok"))).toBe(true);
    expect(completed.threads.every((thread) => thread.finalOutput?.startsWith("Native result"))).toBe(true);
    expect(completed.events.some((event) => event.type === "workflow.completed")).toBe(true);
  });

  it("surfaces app-server approvals and resumes after the user accepts", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codex-loop-approval-"));
    const store = new JsonWorkflowStore(path.join(directory, "data.json"));
    const workflow = await store.addWorkflow(createGeneratedWorkflow("Verify approval routing"));
    const client = new CodexAppServerClient({ command: process.execPath, args: [fixture], env: { FAKE_APPROVAL: "1" } });
    bridge = new CodexBridge(store, client);

    await bridge.startWorkflow(workflow.id);
    const pending = await waitFor(async () => {
      const current = await store.getWorkflow(workflow.id);
      const thread = current.threads.find((candidate) => candidate.pendingApproval);
      return thread ? { current, thread } : undefined;
    });
    expect(pending.thread.pendingApproval?.command).toBe("printf bridge-ok");

    await bridge.resolveApproval(workflow.id, pending.thread.id, "accept");
    const completed = await waitFor(async () => {
      const current = await store.getWorkflow(workflow.id);
      return current.status === "completed" ? current : undefined;
    });
    expect(completed.events.some((event) => event.type === "approval.accepted")).toBe(true);
  });
});

async function waitFor<T>(operation: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await operation();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}
