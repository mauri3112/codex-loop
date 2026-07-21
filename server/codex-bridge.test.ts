import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
    const workflow = await store.addWorkflow(createGeneratedWorkflow("Verify the native bridge", { saved: true }));
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

  it("applies per-run prompt and working-directory overrides to native workers", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codex-loop-run-options-"));
    const store = new JsonWorkflowStore(path.join(directory, "data.json"));
    const projectDirectory = path.join(directory, "project");
    await mkdir(projectDirectory);
    const workflow = await store.addWorkflow(createGeneratedWorkflow("Run with one-time context", { saved: true }));
    bridge = new CodexBridge(store, new CodexAppServerClient({ command: process.execPath, args: [fixture] }));

    await bridge.startWorkflow(workflow.id, {
      source: "manual",
      additionalPrompt: "Focus on the authentication edge case.",
      workingDirectory: projectDirectory,
    });
    const completed = await waitFor(async () => {
      const current = await store.getWorkflow(workflow.id);
      return current.status === "completed" ? current : undefined;
    });

    expect(completed.runs.at(-1)?.additionalPrompt).toBe("Focus on the authentication edge case.");
    expect(completed.runs.at(-1)?.workingDirectory).toBe(projectDirectory);
    expect(completed.threads.every((thread) => thread.codex?.cwd === projectDirectory)).toBe(true);
  });

  it("refuses to execute an unpublished draft", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codex-loop-draft-"));
    const store = new JsonWorkflowStore(path.join(directory, "data.json"));
    const workflow = await store.addWorkflow(createGeneratedWorkflow("Do not execute this draft"));
    bridge = new CodexBridge(store, new CodexAppServerClient({ command: process.execPath, args: [fixture] }));

    await expect(bridge.startWorkflow(workflow.id)).rejects.toThrow("Publish this Loop revision");
    expect((await store.getWorkflow(workflow.id)).runs).toHaveLength(0);
  });

  it("surfaces app-server approvals and resumes after the user accepts", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codex-loop-approval-"));
    const store = new JsonWorkflowStore(path.join(directory, "data.json"));
    const workflow = await store.addWorkflow(createGeneratedWorkflow("Verify approval routing", { saved: true }));
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

  it("captures structured user-input requests, forwards answers, and never persists secrets", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codex-loop-input-"));
    const store = new JsonWorkflowStore(path.join(directory, "data.json"));
    const workflow = await store.addWorkflow(createGeneratedWorkflow("Verify user input routing", { saved: true }));
    const client = new CodexAppServerClient({ command: process.execPath, args: [fixture], env: { FAKE_USER_INPUT: "1" } });
    bridge = new CodexBridge(store, client);

    await bridge.startWorkflow(workflow.id);
    const pending = await waitFor(async () => {
      const current = await store.getWorkflow(workflow.id);
      const attention = current.attentionRequests.find((candidate) => candidate.kind === "user-input" && candidate.status === "open");
      return attention ? { current, attention } : undefined;
    });
    expect(pending.attention.questions?.map((question) => question.isSecret)).toEqual([false, true]);
    const waitingThread = pending.current.threads.find((thread) => thread.id === pending.attention.threadId);
    expect(waitingThread?.status).toBe("waiting");
    expect(pending.current.nodes.find((node) => node.id === waitingThread?.nodeId)?.status).toBe("blocked");

    await bridge.respondToAttention(workflow.id, pending.attention.id, {
      runId: pending.attention.runId,
      expectedTurnId: pending.attention.expectedTurnId,
      answers: { choice: "Safe", token: "super-secret-value" },
    });
    const completed = await waitFor(async () => {
      const current = await store.getWorkflow(workflow.id);
      return current.status === "completed" ? current : undefined;
    });
    expect(completed.attentionRequests.find((candidate) => candidate.id === pending.attention.id)?.status).toBe("resolved");
    expect(JSON.stringify(completed)).not.toContain("super-secret-value");
  });

  it("expires native input when the app-server disconnects", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codex-loop-input-exit-"));
    const store = new JsonWorkflowStore(path.join(directory, "data.json"));
    const workflow = await store.addWorkflow(createGeneratedWorkflow("Expire disconnected input", { saved: true }));
    const client = new CodexAppServerClient({ command: process.execPath, args: [fixture], env: { FAKE_USER_INPUT: "1", FAKE_EXIT_AFTER_INPUT: "1" } });
    bridge = new CodexBridge(store, client);

    await bridge.startWorkflow(workflow.id);
    const expired = await waitFor(async () => {
      const current = await store.getWorkflow(workflow.id);
      const attention = current.attentionRequests.find((candidate) => candidate.kind === "user-input");
      return attention?.status === "expired" ? { current, attention } : undefined;
    });

    expect(expired.attention.status).toBe("expired");
    expect(expired.current.events.some((event) => event.type === "attention.expired")).toBe(true);
  });

  it("expires persisted native input during cold runtime preparation", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codex-loop-input-restart-"));
    const store = new JsonWorkflowStore(path.join(directory, "data.json"));
    const workflow = await store.addWorkflow(createGeneratedWorkflow("Expire input after restart", { saved: true }));
    await store.mutateWorkflow(workflow.id, (draft) => {
      draft.status = "running";
      draft.runs.push({ id: "run-restart", status: "running", step: 0, startedAt: new Date().toISOString() });
      draft.attentionRequests.push({
        id: "attention-before-restart",
        runId: "run-restart",
        kind: "user-input",
        status: "open",
        severity: "warning",
        title: "Input from previous process",
        message: "This request has no live JSON-RPC continuation.",
        createdAt: new Date().toISOString(),
      });
    });
    bridge = new CodexBridge(store, new CodexAppServerClient({ command: process.execPath, args: [fixture] }));

    await bridge.prepareRuntime();

    const current = await store.getWorkflow(workflow.id);
    expect(current.attentionRequests.find((attention) => attention.id === "attention-before-restart")?.status).toBe("expired");
  });

  it("persists retry-exhausted attention in the same terminal failure transition", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codex-loop-retry-attention-"));
    const store = new JsonWorkflowStore(path.join(directory, "data.json"));
    const workflow = await store.addWorkflow(createGeneratedWorkflow("Surface exhausted retries", { saved: true }));
    const client = new CodexAppServerClient({ command: process.execPath, args: [fixture], env: { FAKE_TURN_FAILURE: "1" } });
    bridge = new CodexBridge(store, client);

    await bridge.startWorkflow(workflow.id);
    const failed = await waitFor(async () => {
      const current = await store.getWorkflow(workflow.id);
      const attention = current.attentionRequests.find((candidate) => candidate.kind === "retry-exhausted" && candidate.status === "open");
      return current.status === "failed" && attention ? { current, attention } : undefined;
    });

    expect(failed.current.runs.at(-1)?.status).toBe("stopped");
    expect(failed.attention.nodeId).toBeTruthy();
    expect(failed.current.events.some((event) => event.type === "attention.retry-exhausted")).toBe(true);
  });

  it("routes condition branches and explicitly skips unselected work", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codex-loop-condition-"));
    const store = new JsonWorkflowStore(path.join(directory, "data.json"));
    const workflow = await store.addWorkflow(createGeneratedWorkflow("Route one verified branch", { saved: true }));
    const [condition, selected, skipped] = workflow.nodes;
    await store.mutateWorkflow(workflow.id, (draft) => {
      draft.nodes = draft.nodes.slice(0, 3);
      draft.threads = draft.threads.filter((thread) => draft.nodes.some((node) => node.id === thread.nodeId));
      draft.nodes[0].kind = "condition";
      draft.nodes[0].orchestration = { conditionExpression: "Choose the branch supported by the result" };
      draft.edges = [
        { ...draft.edges[0], id: "condition-selected", source: condition.id, target: selected.id, status: "idle" },
        { ...draft.edges[1], id: "condition-skipped", source: condition.id, target: skipped.id, status: "idle" },
      ];
    });
    bridge = new CodexBridge(store, new CodexAppServerClient({ command: process.execPath, args: [fixture], env: { FAKE_AGENT_OUTPUT: `ROUTE: ${selected.name}` } }));

    await bridge.startWorkflow(workflow.id);
    const completed = await waitFor(async () => {
      const current = await store.getWorkflow(workflow.id);
      return current.status === "completed" ? current : undefined;
    });
    expect(completed.nodes.find((node) => node.id === selected.id)?.status).toBe("completed");
    expect(completed.nodes.find((node) => node.id === skipped.id)?.status).toBe("skipped");
    expect(completed.edges.find((edge) => edge.target === skipped.id)?.status).toBe("skipped");
  });

  it("bounds explicit loop iterations and records each pass", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codex-loop-iteration-"));
    const store = new JsonWorkflowStore(path.join(directory, "data.json"));
    const workflow = await store.addWorkflow(createGeneratedWorkflow("Repeat with a hard stop", { saved: true }));
    await store.mutateWorkflow(workflow.id, (draft) => {
      draft.nodes = draft.nodes.slice(0, 1);
      draft.threads = draft.threads.slice(0, 1);
      draft.edges = [];
      draft.nodes[0].kind = "loop";
      draft.nodes[0].orchestration = { stopCondition: "Stop after two additional checks", maximumIterations: 2 };
      draft.budgets.maximumIterations = 2;
    });
    bridge = new CodexBridge(store, new CodexAppServerClient({ command: process.execPath, args: [fixture], env: { FAKE_AGENT_OUTPUT: "LOOP_STATUS: continue" } }));

    await bridge.startWorkflow(workflow.id);
    const completed = await waitFor(async () => {
      const current = await store.getWorkflow(workflow.id);
      return current.status === "completed" ? current : undefined;
    });
    expect(completed.runs.at(-1)?.consumedIterations).toBe(2);
    expect(completed.nodes[0].attempt).toBe(3);
    expect(completed.events.filter((event) => event.type === "loop.iteration")).toHaveLength(2);
  });

  it("stops a loop after its configured no-progress rounds", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codex-loop-no-progress-"));
    const store = new JsonWorkflowStore(path.join(directory, "data.json"));
    const workflow = await store.addWorkflow(createGeneratedWorkflow("Stop repeated output", { saved: true }));
    await store.mutateWorkflow(workflow.id, (draft) => {
      draft.nodes = draft.nodes.slice(0, 1);
      draft.threads = draft.threads.slice(0, 1);
      draft.edges = [];
      draft.nodes[0].kind = "loop";
      draft.nodes[0].orchestration = { stopCondition: "Stop when the evidence changes", maximumIterations: 5 };
      draft.budgets.maximumIterations = 5;
      draft.budgets.maximumNoProgressRounds = 1;
    });
    bridge = new CodexBridge(store, new CodexAppServerClient({ command: process.execPath, args: [fixture], env: { FAKE_AGENT_OUTPUT: "LOOP_STATUS: continue" } }));

    await bridge.startWorkflow(workflow.id);
    const failed = await waitFor(async () => {
      const current = await store.getWorkflow(workflow.id);
      return current.status === "failed" ? current : undefined;
    });
    expect(failed.runs.at(-1)?.noProgressRounds).toBe(1);
    expect(failed.runs.at(-1)?.consumedIterations).toBe(1);
    expect(failed.nodes[0].status).toBe("stopped");
    expect(failed.events.some((event) => event.type === "workflow.budget-exhausted" && event.message.includes("No progress"))).toBe(true);
  });

  it("tracks app-server token usage and interrupts work at the token ceiling", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codex-loop-token-budget-"));
    const store = new JsonWorkflowStore(path.join(directory, "data.json"));
    const workflow = await store.addWorkflow(createGeneratedWorkflow("Respect the token ceiling", { saved: true }));
    await store.mutateWorkflow(workflow.id, (draft) => {
      draft.nodes = draft.nodes.slice(0, 1);
      draft.threads = draft.threads.slice(0, 1);
      draft.edges = [];
      draft.budgets.maximumTokens = 50;
    });
    bridge = new CodexBridge(store, new CodexAppServerClient({ command: process.execPath, args: [fixture], env: { FAKE_TOKEN_TOTAL: "100", FAKE_TURN_DELAY_MS: "50" } }));

    await bridge.startWorkflow(workflow.id);
    const failed = await waitFor(async () => {
      const current = await store.getWorkflow(workflow.id);
      return current.status === "failed" ? current : undefined;
    });
    expect(failed.runs.at(-1)?.consumedTokens).toBe(100);
    expect(failed.nodes[0].status).toBe("stopped");
    expect(failed.events.some((event) => event.type === "workflow.budget-exhausted" && event.message.includes("Token budget"))).toBe(true);
  });

  it("waits at a human gate and continues only after explicit approval", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codex-loop-gate-"));
    const store = new JsonWorkflowStore(path.join(directory, "data.json"));
    const workflow = await store.addWorkflow(createGeneratedWorkflow("Require approval before execution", { saved: true }));
    const [gate, worker] = workflow.nodes;
    await store.mutateWorkflow(workflow.id, (draft) => {
      draft.nodes = draft.nodes.slice(0, 2);
      draft.threads = draft.threads.slice(0, 2);
      draft.nodes[0].kind = "gate";
      draft.nodes[0].task = "Approve the consequential worker";
      draft.edges = [{ ...draft.edges[0], id: "gate-worker", source: gate.id, target: worker.id, status: "idle" }];
    });
    bridge = new CodexBridge(store, new CodexAppServerClient({ command: process.execPath, args: [fixture] }));

    await bridge.startWorkflow(workflow.id);
    const waiting = await waitFor(async () => {
      const current = await store.getWorkflow(workflow.id);
      const attention = current.attentionRequests.find((request) => request.kind === "approval-gate" && request.status === "open");
      return attention ? { current, attention } : undefined;
    });
    expect(waiting.current.nodes.find((node) => node.id === gate.id)?.status).toBe("blocked");
    expect(waiting.current.nodes.find((node) => node.id === worker.id)?.status).toBe("waiting");

    await bridge.resolveGate(workflow.id, gate.id, "approve");
    const completed = await waitFor(async () => {
      const current = await store.getWorkflow(workflow.id);
      return current.status === "completed" ? current : undefined;
    });
    expect(completed.nodes.every((node) => node.status === "completed")).toBe(true);
    expect(completed.events.some((event) => event.type === "gate.approved")).toBe(true);
  });

  it("delivers a queued intervention exactly once and deduplicates retries", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codex-loop-queue-"));
    const store = new JsonWorkflowStore(path.join(directory, "data.json"));
    const workflow = await store.addWorkflow(createGeneratedWorkflow("Verify queued interventions", { saved: true }));
    const client = new CodexAppServerClient({ command: process.execPath, args: [fixture], env: { FAKE_TURN_DELAY_MS: "80" } });
    bridge = new CodexBridge(store, client);

    await bridge.startWorkflow(workflow.id);
    const active = await waitFor(async () => {
      const current = await store.getWorkflow(workflow.id);
      const thread = current.threads.find((candidate) => candidate.codex?.activeTurnId);
      return thread ? { current, thread } : undefined;
    });
    const input = {
      runId: active.current.runs.at(-1)!.id,
      idempotencyKey: "queue-once",
      delivery: "queue" as const,
      message: "Check the queued constraint before concluding.",
      threadId: active.thread.id,
      expectedTurnId: active.thread.codex?.activeTurnId,
    };
    const notStarted = active.current.threads.find((thread) => !thread.codex?.activeTurnId && thread.codex?.state === "disconnected");
    expect(notStarted).toBeDefined();
    await expect(bridge.submitIntervention(workflow.id, {
      ...input,
      idempotencyKey: "do-not-bypass-dependencies",
      threadId: notStarted!.id,
      expectedTurnId: undefined,
    })).rejects.toThrow("require an active turn");
    await Promise.all([bridge.submitIntervention(workflow.id, input), bridge.submitIntervention(workflow.id, input)]);
    await expect(bridge.submitIntervention(workflow.id, { ...input, message: "Different payload with the same key." })).rejects.toThrow("idempotency key");
    await bridge.pauseWorkflow(workflow.id);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const paused = await store.getWorkflow(workflow.id);
    expect(paused.status).toBe("paused");
    expect(paused.interventions.find((record) => record.idempotencyKey === "queue-once")?.status).toBe("pending");
    await bridge.resumeWorkflow(workflow.id);

    const completed = await waitFor(async () => {
      const current = await store.getWorkflow(workflow.id);
      return current.status === "completed" ? current : undefined;
    });
    expect(completed.interventions.filter((record) => record.idempotencyKey === "queue-once")).toHaveLength(1);
    expect(completed.interventions.find((record) => record.idempotencyKey === "queue-once")?.status).toBe("delivered");
    expect(completed.events.filter((event) => event.type === "intervention.queue-delivered")).toHaveLength(1);
    expect(completed.threads.find((thread) => thread.id === active.thread.id)?.messages.filter((message) => message.content === input.message)).toHaveLength(1);
  });

  it("accepts context guidance for a stopped run without implicitly resuming it", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codex-loop-stopped-context-"));
    const store = new JsonWorkflowStore(path.join(directory, "data.json"));
    const workflow = await store.addWorkflow(createGeneratedWorkflow("Prepare the next recovery attempt"));
    await store.mutateWorkflow(workflow.id, (draft) => {
      draft.status = "failed";
      draft.runs.push({ id: "run-failed", status: "stopped", step: 0, startedAt: new Date().toISOString() });
      draft.nodes[0].status = "failed";
    });
    bridge = new CodexBridge(store, new CodexAppServerClient({ command: process.execPath, args: [fixture] }));

    const updated = await bridge.submitIntervention(workflow.id, {
      runId: "run-failed",
      idempotencyKey: "next-run-context",
      delivery: "context",
      message: "Use the user-provided recovery constraint on the next run.",
      recipientNodeIds: [workflow.nodes[0].id],
    });

    expect(updated.status).toBe("failed");
    expect(updated.runs.at(-1)?.status).toBe("stopped");
    expect(updated.interventions.find((record) => record.idempotencyKey === "next-run-context")?.status).toBe("delivered");
    expect(updated.contextBlocks.some((block) => block.summary.includes("recovery constraint"))).toBe(true);
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
