import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGeneratedWorkflow } from "../src/data/seed.js";
import { CodexBridge } from "../server/codex-bridge.js";
import { JsonWorkflowStore } from "../server/store.js";

const expected = "CODEX_LOOP_BRIDGE_OK";
const directory = await mkdtemp(path.join(os.tmpdir(), "codex-loop-live-bridge-"));
const store = new JsonWorkflowStore(path.join(directory, "data.json"));
const workflow = createGeneratedWorkflow(`Reply with exactly ${expected} and nothing else. Do not inspect or modify files.`);
const node = workflow.nodes[0];
const thread = workflow.threads.find((candidate) => candidate.id === node.threadId);
if (!thread) throw new Error("Verification workflow did not create its agent thread");

node.name = "Verify native Codex bridge";
node.task = `Reply with exactly ${expected} and nothing else. Do not call tools.`;
node.definitionOfDone = `The final response is exactly ${expected}.`;
workflow.name = "Codex Loop bridge verification";
workflow.nodes = [node];
workflow.threads = [thread];
workflow.edges = [];
workflow.contextBlocks = [];
workflow.approvalPolicy = "never";

process.env.CODEX_LOOP_SANDBOX = "read-only";
process.env.CODEX_LOOP_WORKSPACE = process.cwd();

const saved = await store.addWorkflow(workflow);
const bridge = new CodexBridge(store);
let nativeThreadId = "";

try {
  await bridge.startWorkflow(saved.id);
  const completed = await waitFor(async () => {
    const current = await store.getWorkflow(saved.id);
    return current.status === "completed" ? current : undefined;
  });
  const completedThread = completed.threads[0];
  nativeThreadId = completedThread.codex?.threadId ?? "";
  if (!nativeThreadId) throw new Error("Loop did not persist the native Codex thread ID");
  if (!completedThread.codex?.model) throw new Error("Loop did not persist the resolved Codex model");
  if (!completedThread.finalOutput?.includes(expected)) throw new Error(`Unexpected native Codex response: ${completedThread.finalOutput ?? "<empty>"}`);
  if (!completed.events.some((event) => event.type === "thread.created")) throw new Error("Loop did not record native thread creation");
  if (!completed.events.some((event) => event.type === "workflow.completed")) throw new Error("Loop did not complete the native workflow");
  process.stdout.write(`bridge=ok workflow=${saved.id} thread=${nativeThreadId} model=${completedThread.codex.model} response=${expected} persistence=stored-and-archived\n`);
} finally {
  if (nativeThreadId) await bridge.resetWorkflow(saved.id).catch(() => undefined);
  await bridge.close();
  await rm(directory, { recursive: true, force: true });
}

async function waitFor<T>(operation: () => Promise<T | undefined>, timeoutMs = 120_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await operation();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for the native Codex workflow`);
}
