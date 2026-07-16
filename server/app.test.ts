import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppData, Workflow } from "../src/domain/types.js";
import { createApp } from "./app.js";
import { JsonWorkflowStore } from "./store.js";

describe("Codex Loop API and persistence", () => {
  let directory: string;
  let filePath: string;
  let server: Server;
  let origin: string;
  let store: JsonWorkflowStore;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codex-loop-"));
    filePath = path.join(directory, "codex-loop.json");
    store = new JsonWorkflowStore(filePath);
    server = createApp(store).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(directory, { recursive: true, force: true });
  });

  async function json<T>(pathname: string, init?: RequestInit): Promise<{ response: Response; body: T }> {
    const response = await fetch(`${origin}${pathname}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    return { response, body: (await response.json()) as T };
  }

  it("seeds templates, manual threads, and a complete five-agent workflow", async () => {
    const { response, body } = await json<AppData>("/api/data");
    expect(response.status).toBe(200);
    expect(body.templates).toHaveLength(6);
    expect(body.manualThreads.length).toBeGreaterThanOrEqual(3);
    expect(body.workflows[0].nodes).toHaveLength(5);
    expect(body.workflows[0].threads).toHaveLength(5);
    expect(body.workflows[0].edges).toHaveLength(4);
    expect(body.workflows[0].observers).toHaveLength(1);
    expect(body.workflows[0].saved).toBe(true);
  });

  it("generates and immediately persists a task-specific repository workflow", async () => {
    const task = "Fix the race condition in the repository indexer";
    const generated = await json<Workflow>("/api/workflows/generate", {
      method: "POST",
      body: JSON.stringify({ task }),
    });
    expect(generated.response.status).toBe(201);
    expect(generated.body.mainTask).toBe(task);
    expect(generated.body.nodes.map((node) => node.role)).toEqual([
      "investigator",
      "investigator",
      "implementer",
      "tester",
      "reviewer",
    ]);

    const reopened = await json<Workflow>(`/api/workflows/${generated.body.id}`);
    expect(reopened.body).toEqual(generated.body);
  });

  it("creates, updates, saves, and reloads a workflow from disk", async () => {
    const created = await json<Workflow>("/api/workflows", { method: "POST", body: "{}" });
    expect(created.response.status).toBe(201);
    expect(created.body.status).toBe("draft");

    const updatedPayload = { ...created.body, name: "Persisted workflow" };
    const updated = await json<Workflow>(`/api/workflows/${created.body.id}`, {
      method: "PUT",
      body: JSON.stringify(updatedPayload),
    });
    expect(updated.body.name).toBe("Persisted workflow");

    const saved = await json<Workflow>(`/api/workflows/${created.body.id}/save`, { method: "POST" });
    expect(saved.body.saved).toBe(true);

    const reloadedStore = new JsonWorkflowStore(filePath);
    const reloaded = await reloadedStore.getWorkflow(created.body.id);
    expect(reloaded.name).toBe("Persisted workflow");
    expect(reloaded.saved).toBe(true);

    const raw = JSON.parse(await readFile(filePath, "utf8")) as AppData;
    expect(raw.workflows.some((workflow) => workflow.id === created.body.id)).toBe(true);
  });

  it("preserves live Codex runtime state when a stale canvas edit is persisted", async () => {
    const created = await json<Workflow>("/api/workflows/generate", { method: "POST", body: JSON.stringify({ task: "Bridge concurrency" }) });
    const stale = structuredClone(created.body);
    await store.mutateWorkflow(created.body.id, (workflow) => {
      workflow.status = "running";
      workflow.nodes[0].status = "running";
      workflow.nodes[0].progress = 42;
      workflow.threads[0].status = "running";
      workflow.threads[0].codex = { state: "running", threadId: "native-thread", activeTurnId: "native-turn" };
      workflow.threads[0].messages.push({ id: "native-message", role: "assistant", content: "Streaming", timestamp: new Date().toISOString() });
      workflow.events.push({ id: "native-event", sequence: 1, runId: "run", kind: "thread", type: "turn.started", actor: "Codex", message: "Started", timestamp: new Date().toISOString(), logicalTime: 1 });
    });

    stale.name = "Edited while running";
    const updated = await json<Workflow>(`/api/workflows/${stale.id}`, { method: "PUT", body: JSON.stringify(stale) });
    expect(updated.body.name).toBe("Edited while running");
    expect(updated.body.nodes[0].progress).toBe(42);
    expect(updated.body.threads[0].codex?.threadId).toBe("native-thread");
    expect(updated.body.threads[0].messages.some((message) => message.id === "native-message")).toBe(true);
    expect(updated.body.events.some((event) => event.id === "native-event")).toBe(true);
  });

  it("returns useful validation and not-found responses", async () => {
    const invalid = await json<{ error: string }>("/api/workflows/generate", {
      method: "POST",
      body: JSON.stringify({ task: "" }),
    });
    expect(invalid.response.status).toBe(400);
    expect(invalid.body.error).toBe("Invalid request");

    const missing = await json<{ error: string }>("/api/workflows/missing");
    expect(missing.response.status).toBe(404);
    expect(missing.body.error).toContain("was not found");
  });
});
