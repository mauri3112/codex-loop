import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppData, Workflow } from "../src/domain/types.js";
import { workflowDefinition } from "../src/domain/definition.js";
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

  it("reports the running release metadata", async () => {
    const { response, body } = await json<{ version: string; revision: string; builtAt: string }>("/api/version");
    expect(response.status).toBe(200);
    expect(body).toEqual({ version: "development", revision: "unknown", builtAt: "unknown" });
  });

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

  it("creates and versions drafts, blocks invalid publication, and persists valid published workflows", async () => {
    const created = await json<Workflow>("/api/workflows", { method: "POST", body: "{}" });
    expect(created.response.status).toBe(201);
    expect(created.body.status).toBe("draft");

    const updatedPayload = { ...created.body, name: "Persisted workflow" };
    const updated = await json<Workflow>(`/api/workflows/${created.body.id}`, {
      method: "PUT",
      body: JSON.stringify(updatedPayload),
    });
    expect(updated.body.name).toBe("Persisted workflow");
    expect(updated.body.revision).toBe(1);

    const invalidSave = await json<{ error: string }>(`/api/workflows/${created.body.id}/save`, { method: "POST" });
    expect(invalidSave.response.status).toBe(422);

    const generated = await json<Workflow>("/api/workflows/generate", { method: "POST", body: JSON.stringify({ task: "Persist this valid workflow" }) });
    const saved = await json<Workflow>(`/api/workflows/${generated.body.id}/save`, { method: "POST" });
    expect(saved.body.saved).toBe(true);
    expect(saved.body.lifecycle).toBe("published");

    const reloadedStore = new JsonWorkflowStore(filePath);
    const reloaded = await reloadedStore.getWorkflow(generated.body.id);
    expect(reloaded.saved).toBe(true);

    const raw = JSON.parse(await readFile(filePath, "utf8")) as AppData;
    expect(raw.workflows.some((workflow) => workflow.id === generated.body.id)).toBe(true);
  });

  it("deletes stopped Loops and protects active runs", async () => {
    const removable = await json<Workflow>("/api/workflows/generate", { method: "POST", body: JSON.stringify({ task: "Delete this Loop" }) });
    const deleted = await json<{ deleted: true; id: string }>(`/api/workflows/${removable.body.id}`, { method: "DELETE" });
    expect(deleted.response.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true, id: removable.body.id });
    expect((await json<{ error: string }>(`/api/workflows/${removable.body.id}`)).response.status).toBe(404);

    const active = await json<Workflow>("/api/workflows/generate", { method: "POST", body: JSON.stringify({ task: "Keep the active Loop" }) });
    await store.mutateWorkflow(active.body.id, (workflow) => { workflow.status = "running"; });
    const rejected = await json<{ error: string }>(`/api/workflows/${active.body.id}`, { method: "DELETE" });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toContain("Stop this Loop");
  });

  it("applies optimistic definition mutations and records undo as a new revision", async () => {
    const created = await json<Workflow>("/api/workflows/generate", { method: "POST", body: JSON.stringify({ task: "Version this Loop" }) });
    const definition = workflowDefinition(created.body);
    definition.name = "Versioned by Designer";
    const mutated = await json<Workflow>(`/api/workflows/${created.body.id}/mutations`, {
      method: "POST",
      body: JSON.stringify({ baseRevision: 0, actor: "designer", rationale: "Name the generated Loop", definition }),
    });
    expect(mutated.response.status).toBe(201);
    expect(mutated.body.revision).toBe(1);
    expect(mutated.body.name).toBe("Versioned by Designer");
    expect(mutated.body.mutations.at(-1)?.actor).toBe("designer");

    const conflict = await json<{ error: string }>(`/api/workflows/${created.body.id}/mutations`, {
      method: "POST",
      body: JSON.stringify({ baseRevision: 0, actor: "mcp", rationale: "Apply a stale patch", definition }),
    });
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.error).toContain("current revision is 1");

    const undone = await json<Workflow>(`/api/workflows/${created.body.id}/undo`, { method: "POST", body: "{}" });
    expect(undone.body.revision).toBe(2);
    expect(undone.body.name).toBe(created.body.name);
    expect(undone.body.mutations.at(-1)?.undoneMutationId).toBe(mutated.body.mutations.at(-1)?.id);
  });

  it("serves authenticated MCP discovery and draft creation over JSON-RPC", async () => {
    const previousToken = process.env.CODEX_LOOP_MCP_TOKEN;
    process.env.CODEX_LOOP_MCP_TOKEN = "test-mcp-token";
    try {
      const unauthorized = await json<{ error: string }>("/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      expect(unauthorized.response.status).toBe(401);

      const headers = { Authorization: "Bearer test-mcp-token" };
      const initialized = await json<{ result: { serverInfo: { name: string }; capabilities: { tools: object } } }>("/mcp", {
        method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }),
      });
      expect(initialized.body.result.serverInfo.name).toBe("codex-loop");
      expect(initialized.body.result.capabilities.tools).toBeDefined();

      const listed = await json<{ result: { tools: Array<{ name: string }> } }>("/mcp", {
        method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
      });
      expect(listed.body.result.tools.map((tool) => tool.name)).toContain("loop_designer_message");
      expect(listed.body.result.tools.map((tool) => tool.name)).toContain("loop_gate_decision");

      const draft = await json<{ result: { structuredContent: { workflow: Workflow; deepLink: string } } }>("/mcp", {
        method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "loop_create_draft", arguments: { name: "From Codex", objective: "Create a test Loop" } } }),
      });
      expect(draft.body.result.structuredContent.workflow.name).toBe("From Codex");
      expect(draft.body.result.structuredContent.deepLink).toContain(`/loop/${draft.body.result.structuredContent.workflow.id}`);

      const unknown = await json<{ error: { code: number } }>("/mcp", {
        method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "not/a/method", params: {} }),
      });
      expect(unknown.body.error.code).toBe(-32601);
    } finally {
      if (previousToken === undefined) delete process.env.CODEX_LOOP_MCP_TOKEN;
      else process.env.CODEX_LOOP_MCP_TOKEN = previousToken;
    }
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

  it("creates explicit context interventions and rejects stale turn steering", async () => {
    const created = await json<Workflow>("/api/workflows/generate", { method: "POST", body: JSON.stringify({ task: "Intervention API" }) });
    const running = await store.mutateWorkflow(created.body.id, (workflow) => {
      workflow.status = "running";
      workflow.runs.push({ id: "run-api", status: "running", step: 0, startedAt: new Date().toISOString() });
      workflow.threads[0].codex = { state: "running", threadId: "native-api", activeTurnId: "turn-current" };
    });
    const context = await json<Workflow>(`/api/workflows/${running.id}/interventions`, {
      method: "POST",
      body: JSON.stringify({ runId: "run-api", idempotencyKey: "api-context", delivery: "context", message: "Honor the user constraint.", recipientNodeIds: [running.nodes[0].id] }),
    });
    expect(context.response.status).toBe(201);
    expect(context.body.interventions.find((record) => record.idempotencyKey === "api-context")?.status).toBe("delivered");
    expect(context.body.contextBlocks.some((block) => block.createdBy === "manual" && block.summary === "Honor the user constraint.")).toBe(true);

    const stale = await json<{ error: string }>(`/api/workflows/${running.id}/interventions`, {
      method: "POST",
      body: JSON.stringify({ runId: "run-api", idempotencyKey: "api-stale", delivery: "steer", message: "Steer this turn.", threadId: running.threads[0].id, expectedTurnId: "turn-stale" }),
    });
    expect(stale.response.status).toBe(409);
    expect(stale.body.error).toContain("changed");

    const invalidQueue = await json<{ error: string }>(`/api/workflows/${running.id}/interventions`, {
      method: "POST",
      body: JSON.stringify({ runId: "run-api", idempotencyKey: "api-invalid", delivery: "queue", message: "Missing a target." }),
    });
    expect(invalidQueue.response.status).toBe(400);
    expect(invalidQueue.body.error).toBe("Invalid request");

    const missingAttention = await json<{ error: string }>(`/api/workflows/${running.id}/attention/missing/respond`, {
      method: "POST",
      body: JSON.stringify({ runId: "run-api", expectedTurnId: "turn-current", answers: { choice: "Safe" } }),
    });
    expect(missingAttention.response.status).toBe(404);
    expect(missingAttention.body.error).toContain("was not found");
  });
});
