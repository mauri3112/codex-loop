import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGeneratedWorkflow } from "../src/data/seed.js";
import type { Workflow } from "../src/domain/types.js";
import { createApp } from "./app.js";
import type { BridgeStatus, CodexBridgeService, RunInvocation } from "./codex-bridge.js";
import { JsonWorkflowStore } from "./store.js";

describe("webhook workflow runs", () => {
  let directory = "";
  let server: Server;
  let origin = "";
  let store: JsonWorkflowStore;
  const starts: Array<{ id: string; invocation?: RunInvocation }> = [];

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codex-loop-trigger-"));
    store = new JsonWorkflowStore(path.join(directory, "data.json"));
    const workflow = createGeneratedWorkflow("Run from a webhook", { id: "webhook-loop" });
    workflow.runConfiguration = {
      ...workflow.runConfiguration,
      mode: "webhook",
      webhook: {
        token: "test_webhook_token_1234",
        parameters: [
          { id: "branch", key: "branch", defaultValue: "main" },
          { id: "environment", key: "environment", defaultValue: "staging" },
        ],
      },
    };
    await store.addWorkflow(workflow);
    const bridge: CodexBridgeService = {
      status: (): BridgeStatus => ({ state: "connected" }),
      connect: async () => ({ state: "connected" }),
      startWorkflow: async (id, invocation) => {
        starts.push({ id, invocation });
        return store.mutateWorkflow(id, (draft) => {
          draft.runs.push({ id: `run-${starts.length}`, source: invocation?.source, input: invocation?.input, status: "completed", step: 1, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
          draft.status = "completed";
        });
      },
      pauseWorkflow: (id) => store.getWorkflow(id),
      resumeWorkflow: (id) => store.getWorkflow(id),
      stopWorkflow: (id) => store.getWorkflow(id),
      resetWorkflow: (id) => store.getWorkflow(id),
      sendInstruction: (id) => store.getWorkflow(id),
      stopThread: (id) => store.getWorkflow(id),
      resolveApproval: (id) => store.getWorkflow(id),
    };
    server = createApp(store, bridge).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    starts.length = 0;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  it("accepts POST values, merges defaults, and records webhook provenance", async () => {
    const response = await fetch(`${origin}/api/triggers/test_webhook_token_1234`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feature/split-run", attempt: 2 }),
    });
    const workflow = await response.json() as Workflow;
    expect(response.status).toBe(202);
    expect(starts[0]).toEqual({
      id: "webhook-loop",
      invocation: { source: "webhook", input: { branch: "feature/split-run", environment: "staging", attempt: 2 } },
    });
    expect(workflow.runs.at(-1)?.source).toBe("webhook");
    expect(workflow.runs.at(-1)?.input).toEqual({ branch: "feature/split-run", environment: "staging", attempt: 2 });
  });

  it("supports a simple GET trigger and rejects unknown tokens", async () => {
    const triggered = await fetch(`${origin}/api/triggers/test_webhook_token_1234?branch=hotfix`);
    expect(triggered.status).toBe(202);
    expect(starts[0].invocation?.input).toEqual({ branch: "hotfix", environment: "staging" });
    const missing = await fetch(`${origin}/api/triggers/not_a_real_trigger`);
    expect(missing.status).toBe(404);
  });
});
