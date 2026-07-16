import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGeneratedWorkflow } from "../src/data/seed.js";
import { AttentionSupervisor } from "./attention-supervisor.js";
import { JsonWorkflowStore } from "./store.js";

describe("attention supervisor", () => {
  let directory = "";

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("detects and deduplicates deadlocks", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codex-loop-supervisor-"));
    const store = new JsonWorkflowStore(path.join(directory, "data.json"));
    const workflow = await store.addWorkflow(createGeneratedWorkflow("Detect deadlock"));
    await store.mutateWorkflow(workflow.id, (draft) => {
      draft.status = "running";
      draft.runs.push({ id: "run-deadlock", status: "running", step: 0, startedAt: "2026-07-16T10:00:00.000Z" });
      for (const node of draft.nodes) node.status = "blocked";
    });
    const supervisor = new AttentionSupervisor(store, { now: () => new Date("2026-07-16T10:10:00.000Z") });

    await supervisor.scan();
    await supervisor.scan();

    const current = await store.getWorkflow(workflow.id);
    expect(current.attentionRequests.filter((attention) => attention.kind === "deadlock" && attention.status === "open")).toHaveLength(1);
    expect(current.events.filter((event) => event.type === "attention.deadlock")).toHaveLength(1);
  });

  it("flags an active turn after the configured inactivity threshold", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codex-loop-stall-"));
    const store = new JsonWorkflowStore(path.join(directory, "data.json"));
    const workflow = await store.addWorkflow(createGeneratedWorkflow("Detect stall"));
    await store.mutateWorkflow(workflow.id, (draft) => {
      draft.status = "running";
      draft.runs.push({ id: "run-stall", status: "running", step: 0, startedAt: "2026-07-16T10:00:00.000Z" });
      const thread = draft.threads[0];
      thread.status = "running";
      thread.lastActivityAt = "2026-07-16T10:00:00.000Z";
      thread.codex = { state: "running", threadId: "native-1", activeTurnId: "turn-1" };
    });
    const supervisor = new AttentionSupervisor(store, { stallThresholdMs: 60_000, now: () => new Date("2026-07-16T10:02:00.000Z") });

    await supervisor.scan();

    const current = await store.getWorkflow(workflow.id);
    const attention = current.attentionRequests.find((candidate) => candidate.kind === "suspected-stall");
    expect(attention).toMatchObject({ status: "open", expectedTurnId: "turn-1", threadId: current.threads[0].id });

    await store.mutateWorkflow(workflow.id, (draft) => {
      draft.threads[0].lastActivityAt = "2026-07-16T10:01:45.000Z";
    });
    await supervisor.scan();

    const recovered = await store.getWorkflow(workflow.id);
    expect(recovered.attentionRequests.find((candidate) => candidate.id === attention?.id)?.status).toBe("resolved");
    expect(recovered.events.some((event) => event.type === "attention.suspected-stall-resolved")).toBe(true);
  });

  it("does not classify a branch that is explicitly waiting for user input as stalled", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codex-loop-waiting-input-"));
    const store = new JsonWorkflowStore(path.join(directory, "data.json"));
    const workflow = await store.addWorkflow(createGeneratedWorkflow("Wait for a user decision"));
    await store.mutateWorkflow(workflow.id, (draft) => {
      draft.status = "running";
      draft.runs.push({ id: "run-input", status: "running", step: 0, startedAt: "2026-07-16T10:00:00.000Z" });
      const thread = draft.threads[0];
      thread.status = "waiting";
      thread.lastActivityAt = "2026-07-16T10:00:00.000Z";
      thread.codex = { state: "running", threadId: "native-input", activeTurnId: "turn-input" };
      draft.attentionRequests.push({
        id: "attention-input",
        runId: "run-input",
        kind: "user-input",
        status: "open",
        severity: "warning",
        title: "Input required",
        message: "Choose a path.",
        threadId: thread.id,
        nodeId: thread.nodeId,
        expectedTurnId: "turn-input",
        createdAt: "2026-07-16T10:00:00.000Z",
      });
    });
    const supervisor = new AttentionSupervisor(store, { stallThresholdMs: 60_000, now: () => new Date("2026-07-16T10:10:00.000Z") });

    await supervisor.scan();

    const current = await store.getWorkflow(workflow.id);
    expect(current.attentionRequests.some((attention) => attention.kind === "suspected-stall")).toBe(false);
  });
});
