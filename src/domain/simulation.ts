import type { AgentNode, AuditEvent, ContextBlock, ThreadRecord, Workflow } from "./types";

const iso = () => new Date().toISOString();
const uid = (prefix: string, step: number, suffix = "") => `${prefix}-${step}${suffix ? `-${suffix}` : ""}`;

function addEvent(workflow: Workflow, step: number, event: Omit<AuditEvent, "id" | "sequence" | "runId" | "timestamp" | "logicalTime">) {
  const run = workflow.runs.at(-1)!;
  workflow.events.push({
    ...event,
    id: uid("event", step, String(workflow.events.length + 1)),
    sequence: workflow.events.length + 1,
    runId: run.id,
    timestamp: iso(),
    logicalTime: step,
  });
}

const byRole = (workflow: Workflow, role: AgentNode["role"], nth = 0) => workflow.nodes.filter((node) => node.role === role)[nth];
const threadFor = (workflow: Workflow, node: AgentNode) => workflow.threads.find((thread) => thread.id === node.threadId)!;

function setNode(workflow: Workflow, node: AgentNode, patch: Partial<AgentNode>) {
  Object.assign(node, patch);
  Object.assign(threadFor(workflow, node), { status: patch.status ?? node.status, model: patch.effectiveModel ?? node.effectiveModel });
}

function message(thread: ThreadRecord, role: "assistant" | "system" | "user", content: string, step: number) {
  thread.messages.push({ id: uid("message", step, String(thread.messages.length + 1)), role, content, timestamp: iso() });
}

function createContext(workflow: Workflow, step: number, input: Omit<ContextBlock, "id" | "createdAt" | "position">) {
  const contextIndex = workflow.contextBlocks.length;
  const block: ContextBlock = {
    ...input,
    id: uid("context", step),
    createdAt: iso(),
    position: { x: 60 + (contextIndex % 3) * 270, y: 560 + Math.floor(contextIndex / 3) * 120 },
  };
  workflow.contextBlocks.push(block);
  addEvent(workflow, step, { kind: "context", type: "context.created", actor: "Context system", message: `Created context block “${block.title}”`, contextBlockId: block.id, nodeId: input.sourceThreadId ? workflow.nodes.find((n) => n.threadId === input.sourceThreadId)?.id : undefined });
  return block;
}

function grant(workflow: Workflow, step: number, block: ContextBlock, nodes: AgentNode[]) {
  for (const node of nodes) {
    if (!block.allowedAgentNodeIds.includes(node.id)) block.allowedAgentNodeIds.push(node.id);
    if (!node.readableContextBlockIds.includes(block.id)) node.readableContextBlockIds.push(block.id);
    addEvent(workflow, step, { kind: "context", type: "context.permission-granted", actor: "Context system", message: `Shared “${block.title}” with ${node.name}`, nodeId: node.id, contextBlockId: block.id });
  }
}

export const SIMULATION_STEPS = 22;

export function startWorkflow(input: Workflow): Workflow {
  const workflow = structuredClone(input);
  const runNumber = workflow.runs.length + 1;
  workflow.runs.push({ id: `run-${workflow.id}-${runNumber}`, status: "running", step: 0, startedAt: iso() });
  workflow.status = "running";
  workflow.events = [];
  workflow.contextBlocks = [];
  workflow.nodes.forEach((node) => setNode(workflow, node, { status: node.role === "investigator" ? "queued" : "waiting", attempt: 0, progress: 0, effectiveModel: node.configuredModel, readableContextBlockIds: [] }));
  workflow.edges.forEach((edge) => { edge.status = "idle"; });
  workflow.observers.forEach((observer) => { observer.status = "watching"; });
  addEvent(workflow, 0, { kind: "workflow", type: "workflow.started", actor: "You", message: "Workflow started · investigation agents queued" });
  return workflow;
}

export function applySimulationStep(input: Workflow): Workflow {
  const workflow = structuredClone(input);
  const run = workflow.runs.at(-1);
  if (!run || run.status !== "running" || run.step >= SIMULATION_STEPS) return workflow;
  const step = ++run.step;
  const investigators = workflow.nodes.filter((node) => node.role === "investigator");
  const investigatorA = investigators[0];
  const investigatorB = investigators[1] ?? investigators[0];
  const implementer = byRole(workflow, "implementer");
  const tester = byRole(workflow, "tester");
  const reviewer = byRole(workflow, "reviewer");
  const observer = workflow.observers[0];

  switch (step) {
    case 1:
      investigators.forEach((node) => {
        setNode(workflow, node, { status: "running", attempt: 1, progress: 12 });
        threadFor(workflow, node).attempts = [{ number: 1, model: node.effectiveModel, status: "running", receivedContextBlockIds: [], summary: "Investigation started" }];
        addEvent(workflow, step, { kind: "agent", type: "node.started", actor: node.name, message: `${node.name} started in parallel`, nodeId: node.id });
      });
      break;
    case 2:
      investigators.forEach((node, index) => {
        setNode(workflow, node, { progress: 38 });
        const thread = threadFor(workflow, node);
        thread.toolCalls.push({ id: uid("tool", step, String(index)), name: index ? "Read tests" : "Search repository", command: index ? "npm test -- --reporter=verbose" : "rg -n 'race|cache|async' src tests", output: index ? "Located 18 concurrency tests" : "Found async cache update path", status: "completed" });
        message(thread, "assistant", index ? "I’m mapping the failing test to the expected concurrency behavior." : "I found a shared cache update path that is not guarded across concurrent requests.", step);
        addEvent(workflow, step, { kind: "tool", type: "tool.completed", actor: node.name, message: index ? "Inspected the concurrency test suite" : "Searched async cache paths", nodeId: node.id });
      });
      break;
    case 3: {
      setNode(workflow, investigatorA, { status: "completed", progress: 100 });
      threadFor(workflow, investigatorA).attempts[0].status = "completed";
      threadFor(workflow, investigatorA).finalOutput = "The failure is caused by a non-atomic cache refresh. Concurrent misses overwrite one another.";
      addEvent(workflow, step, { kind: "agent", type: "node.completed", actor: investigatorA.name, message: "Found a likely race condition in the cache refresh path", nodeId: investigatorA.id });
      const block = createContext(workflow, step, { title: "Likely race condition", summary: "Concurrent cache misses can overwrite a newer value because refresh and commit are not atomic.", category: "repository-finding", sourceThreadId: investigatorA.threadId, createdBy: "system", allowedAgentNodeIds: [], estimatedTokens: 126 });
      grant(workflow, step, block, [implementer]);
      break;
    }
    case 4: {
      setNode(workflow, investigatorB, { status: "completed", progress: 100 });
      threadFor(workflow, investigatorB).attempts[0].status = "completed";
      threadFor(workflow, investigatorB).finalOutput = "The fix must preserve stale-read behavior and pass the concurrency and regression suites.";
      addEvent(workflow, step, { kind: "agent", type: "node.completed", actor: investigatorB.name, message: "Mapped acceptance criteria and regression coverage", nodeId: investigatorB.id });
      const block = createContext(workflow, step, { title: "Acceptance criteria", summary: "Make refresh commits atomic, preserve stale reads, and pass concurrency plus regression tests.", category: "acceptance-criteria", sourceThreadId: investigatorB.threadId, createdBy: "system", allowedAgentNodeIds: [], estimatedTokens: 94 });
      grant(workflow, step, block, [implementer, tester]);
      break;
    }
    case 5:
      workflow.edges.filter((edge) => investigators.some((node) => node.id === edge.source) && edge.target === implementer.id).forEach((edge) => { edge.status = "active"; addEvent(workflow, step, { kind: "edge", type: "edge.activated", actor: "Loop", message: "Investigation context is moving to Implementation", edgeId: edge.id, nodeId: implementer.id }); });
      setNode(workflow, implementer, { status: "queued", progress: 4 });
      addEvent(workflow, step, { kind: "context", type: "context.summary", actor: "Context system", message: "The investigators found a likely race condition. The finding and acceptance criteria were shared with Implementation.", nodeId: implementer.id });
      break;
    case 6: {
      setNode(workflow, implementer, { status: "running", attempt: 1, progress: 18 });
      const thread = threadFor(workflow, implementer);
      thread.attempts = [{ number: 1, model: implementer.effectiveModel, status: "running", receivedContextBlockIds: [...implementer.readableContextBlockIds], summary: "Implementing atomic cache refresh" }];
      message(thread, "assistant", "I’ll make the smallest locking change around cache commit and validate the focused suite first.", step);
      addEvent(workflow, step, { kind: "agent", type: "node.started", actor: implementer.name, message: `Implementation attempt 1 started with ${implementer.effectiveModel}`, nodeId: implementer.id });
      break;
    }
    case 7:
      setNode(workflow, implementer, { progress: 48 });
      threadFor(workflow, implementer).toolCalls.push({ id: uid("tool", step), name: "Apply patch", command: "apply_patch src/cache/refresh.ts", output: "Updated lock boundary", status: "completed" });
      addEvent(workflow, step, { kind: "tool", type: "tool.completed", actor: implementer.name, message: "Updated the cache refresh lock boundary", nodeId: implementer.id });
      break;
    case 8: {
      setNode(workflow, implementer, { status: "failed", progress: 62 });
      const thread = threadFor(workflow, implementer);
      thread.attempts[0].status = "failed";
      thread.attempts[0].summary = "Focused test exposed a lock re-entry deadlock";
      thread.toolCalls.push({ id: uid("tool", step), name: "Run focused tests", command: "npm test -- cache.concurrent", output: "FAIL: timed out waiting for nested cache lock", status: "failed" });
      message(thread, "assistant", "The first patch deadlocks on the nested refresh path. I’m stopping this attempt before broadening the change.", step);
      addEvent(workflow, step, { kind: "tool", type: "tool.failed", actor: implementer.name, message: "Focused test failed: nested lock re-entry deadlock", nodeId: implementer.id, detail: "Attempt 1 failed" });
      addEvent(workflow, step, { kind: "agent", type: "node.failed", actor: implementer.name, message: "Implementation attempt 1 failed", nodeId: implementer.id });
      break;
    }
    case 9:
      setNode(workflow, implementer, { status: "blocked" });
      observer.status = "intervening";
      addEvent(workflow, step, { kind: "observer", type: "observer.failure-detected", actor: observer.name, message: "Detected a retryable implementation failure", nodeId: implementer.id, observerId: observer.id });
      addEvent(workflow, step, { kind: "context", type: "context.warning", actor: "Context system", message: "Implementation failed its first attempt. The Observer is reviewing the failure.", nodeId: implementer.id });
      break;
    case 10: {
      const guidance = createContext(workflow, step, { title: "Retry guidance", summary: "Use a single-flight refresh promise instead of a re-entrant mutex around nested calls.", category: "architecture-decision", sourceThreadId: implementer.threadId, createdBy: "observer", allowedAgentNodeIds: [], estimatedTokens: 82 });
      grant(workflow, step, guidance, [implementer]);
      addEvent(workflow, step, { kind: "observer", type: "observer.retry-authorized", actor: observer.name, message: "Authorized one retry with a stronger model", nodeId: implementer.id, observerId: observer.id });
      break;
    }
    case 11:
      setNode(workflow, implementer, { status: "retrying", attempt: 2, effectiveModel: implementer.retryPolicy.upgradeModelTo, progress: 25 });
      addEvent(workflow, step, { kind: "model", type: "model.upgraded", actor: observer.name, message: `Upgraded ${implementer.name} to ${implementer.retryPolicy.upgradeModelTo}`, nodeId: implementer.id, observerId: observer.id });
      addEvent(workflow, step, { kind: "agent", type: "node.retrying", actor: implementer.name, message: "Retry 1 of 2 scheduled", nodeId: implementer.id });
      break;
    case 12: {
      setNode(workflow, implementer, { status: "running", progress: 42 });
      const thread = threadFor(workflow, implementer);
      thread.attempts.push({ number: 2, model: implementer.effectiveModel, status: "running", receivedContextBlockIds: [...implementer.readableContextBlockIds], summary: "Applying single-flight refresh design" });
      message(thread, "assistant", "The Observer’s guidance fits the call graph. I’m replacing the lock with a shared in-flight refresh promise.", step);
      addEvent(workflow, step, { kind: "agent", type: "node.started", actor: implementer.name, message: `Implementation attempt 2 started with ${implementer.effectiveModel}`, nodeId: implementer.id });
      break;
    }
    case 13:
      setNode(workflow, implementer, { progress: 74 });
      threadFor(workflow, implementer).toolCalls.push({ id: uid("tool", step), name: "Run tests", command: "npm test -- cache.concurrent cache.regression", output: "18 passed", status: "completed" });
      addEvent(workflow, step, { kind: "tool", type: "tool.completed", actor: implementer.name, message: "Focused concurrency and regression tests passed", nodeId: implementer.id });
      break;
    case 14: {
      setNode(workflow, implementer, { status: "completed", progress: 100 });
      observer.status = "watching";
      const thread = threadFor(workflow, implementer);
      thread.attempts[1].status = "completed";
      thread.attempts[1].summary = "Single-flight refresh implemented and verified";
      thread.fileChanges = [{ path: "src/cache/refresh.ts", additions: 34, deletions: 18, summary: "Replace re-entrant lock with a shared in-flight refresh" }, { path: "tests/cache.concurrent.test.ts", additions: 27, deletions: 2, summary: "Cover overlapping refresh completion order" }];
      thread.finalOutput = "Implemented a single-flight cache refresh, added overlapping-request coverage, and passed the focused test suite.";
      addEvent(workflow, step, { kind: "agent", type: "node.completed", actor: implementer.name, message: "Implementation succeeded on attempt 2", nodeId: implementer.id });
      addEvent(workflow, step, { kind: "file", type: "file.changed", actor: implementer.name, message: "Changed 2 files · +61 −20", nodeId: implementer.id });
      const changed = createContext(workflow, step, { title: "Changed files", summary: "Updated cache refresh coordination and added overlapping-request regression coverage.", category: "changed-files", sourceThreadId: implementer.threadId, createdBy: "system", allowedAgentNodeIds: [], estimatedTokens: 110 });
      grant(workflow, step, changed, [tester]);
      break;
    }
    case 15:
      workflow.edges.filter((edge) => edge.source === implementer.id).forEach((edge) => { edge.status = "satisfied"; });
      setNode(workflow, tester, { status: "queued", progress: 5 });
      addEvent(workflow, step, { kind: "context", type: "context.summary", actor: "Context system", message: "The test thread cannot access the implementation discussion. It received only changed files and acceptance criteria.", nodeId: tester.id });
      break;
    case 16: {
      setNode(workflow, tester, { status: "running", attempt: 1, progress: 28 });
      const thread = threadFor(workflow, tester);
      thread.attempts = [{ number: 1, model: tester.effectiveModel, status: "running", receivedContextBlockIds: [...tester.readableContextBlockIds], summary: "Verifying focused and full suites" }];
      thread.toolCalls.push({ id: uid("tool", step), name: "Run full test suite", command: "npm test", output: "Running 146 tests…", status: "running" });
      addEvent(workflow, step, { kind: "agent", type: "node.started", actor: tester.name, message: "Verification started with curated context", nodeId: tester.id });
      break;
    }
    case 17:
      setNode(workflow, tester, { progress: 72 });
      addEvent(workflow, step, { kind: "tool", type: "tool.completed", actor: tester.name, message: "146 tests passed · typecheck clean", nodeId: tester.id });
      break;
    case 18: {
      setNode(workflow, tester, { status: "completed", progress: 100 });
      const thread = threadFor(workflow, tester);
      thread.attempts[0].status = "completed";
      thread.toolCalls[0].status = "completed";
      thread.toolCalls[0].output = "146 passed in 18.4s · TypeScript clean";
      thread.finalOutput = "All focused and regression tests pass. The fix preserves stale-read behavior.";
      addEvent(workflow, step, { kind: "agent", type: "node.completed", actor: tester.name, message: "Verification completed successfully", nodeId: tester.id });
      const results = createContext(workflow, step, { title: "Test results", summary: "146 tests passed, including concurrency regressions. TypeScript checks are clean.", category: "test-results", sourceThreadId: tester.threadId, createdBy: "system", allowedAgentNodeIds: [], estimatedTokens: 68 });
      grant(workflow, step, results, [reviewer]);
      break;
    }
    case 19:
      setNode(workflow, reviewer, { status: "running", attempt: 1, progress: 26 });
      threadFor(workflow, reviewer).attempts = [{ number: 1, model: reviewer.effectiveModel, status: "running", receivedContextBlockIds: [...reviewer.readableContextBlockIds], summary: "Reviewing implementation evidence" }];
      addEvent(workflow, step, { kind: "agent", type: "node.started", actor: reviewer.name, message: "Final review started", nodeId: reviewer.id });
      break;
    case 20:
      setNode(workflow, reviewer, { progress: 68 });
      threadFor(workflow, reviewer).toolCalls.push({ id: uid("tool", step), name: "Review diff", command: "git diff --check && git diff --stat", output: "Clean · 2 files changed", status: "completed" });
      addEvent(workflow, step, { kind: "tool", type: "tool.completed", actor: reviewer.name, message: "Reviewed diff, tests, and acceptance criteria", nodeId: reviewer.id });
      break;
    case 21: {
      setNode(workflow, reviewer, { status: "completed", progress: 100 });
      const thread = threadFor(workflow, reviewer);
      thread.attempts[0].status = "completed";
      thread.finalOutput = "Approved. The change is minimal, tested, and satisfies the acceptance criteria without expanding scope.";
      addEvent(workflow, step, { kind: "agent", type: "node.completed", actor: reviewer.name, message: "Review approved the verified change", nodeId: reviewer.id });
      break;
    }
    case 22:
      run.status = "completed";
      run.completedAt = iso();
      workflow.status = "completed";
      addEvent(workflow, step, { kind: "context", type: "context.summary", actor: "Context system", message: "The workflow is complete. Verified changes and the final review were extracted into shared context." });
      addEvent(workflow, step, { kind: "workflow", type: "workflow.completed", actor: "Loop", message: "Workflow completed · 5 threads · 2 implementation attempts · 146 tests passed" });
      break;
  }
  workflow.updatedAt = iso();
  return workflow;
}

export function pauseWorkflow(input: Workflow): Workflow {
  const workflow = structuredClone(input);
  const run = workflow.runs.at(-1);
  if (run?.status === "running") { run.status = "paused"; workflow.status = "paused"; addEvent(workflow, run.step, { kind: "workflow", type: "workflow.paused", actor: "You", message: "Workflow paused" }); }
  return workflow;
}

export function resumeWorkflow(input: Workflow): Workflow {
  const workflow = structuredClone(input);
  const run = workflow.runs.at(-1);
  if (run?.status === "paused") { run.status = "running"; workflow.status = "running"; addEvent(workflow, run.step, { kind: "workflow", type: "workflow.resumed", actor: "You", message: "Workflow resumed" }); }
  return workflow;
}

export function stopWorkflow(input: Workflow): Workflow {
  const workflow = structuredClone(input);
  const run = workflow.runs.at(-1);
  if (run && (run.status === "running" || run.status === "paused")) {
    run.status = "stopped"; workflow.status = "stopped";
    workflow.nodes.filter((node) => ["running", "queued", "waiting", "retrying", "blocked"].includes(node.status)).forEach((node) => setNode(workflow, node, { status: "stopped" }));
    addEvent(workflow, run.step, { kind: "workflow", type: "workflow.stopped", actor: "You", message: "Workflow stopped" });
  }
  return workflow;
}

export function resetWorkflow(input: Workflow): Workflow {
  const workflow = structuredClone(input);
  workflow.status = "ready";
  workflow.nodes.forEach((node) => setNode(workflow, node, { status: "idle", attempt: 0, progress: 0, effectiveModel: node.configuredModel, readableContextBlockIds: [] }));
  workflow.edges.forEach((edge) => { edge.status = "idle"; });
  workflow.observers.forEach((observer) => { observer.status = "idle"; });
  workflow.contextBlocks = workflow.contextBlocks.filter((block) => block.createdBy === "manual");
  return workflow;
}
