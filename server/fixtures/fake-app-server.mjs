import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
let threadSequence = 0;
let turnSequence = 0;
let approvalSent = false;
const pendingApprovalTurns = new Map();

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

function completeTurn(threadId, turnId) {
  const command = { type: "commandExecution", id: `command-${turnId}`, command: "printf bridge-ok", cwd: process.cwd(), processId: null, source: "agent", status: "completed", commandActions: [], aggregatedOutput: "bridge-ok", exitCode: 0, durationMs: 1 };
  const agent = { type: "agentMessage", id: `message-${turnId}`, text: `Native result for ${threadId}`, phase: "final_answer", memoryCitation: null };
  send({ method: "item/started", params: { threadId, turnId, item: { ...command, status: "inProgress" }, startedAtMs: Date.now() } });
  send({ method: "item/completed", params: { threadId, turnId, item: command, completedAtMs: Date.now() } });
  send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: agent.id, delta: agent.text } });
  send({ method: "item/completed", params: { threadId, turnId, item: agent, completedAtMs: Date.now() } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [command, agent], itemsView: "full", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1 } } });
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/tmp/fake-codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    const threadId = `native-thread-${++threadSequence}`;
    send({ id: message.id, result: { thread: { id: threadId }, model: "fake-codex-model", cwd: message.params.cwd } });
    return;
  }
  if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: message.params.threadId }, model: "fake-codex-model", cwd: message.params.cwd ?? process.cwd() } });
    return;
  }
  if (message.method === "thread/name/set" || message.method === "thread/archive" || message.method === "turn/interrupt" || message.method === "turn/steer") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "turn/start") {
    const turnId = `native-turn-${++turnSequence}`;
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
    send({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: turnId, status: "inProgress" } } });
    if (process.env.FAKE_APPROVAL === "1" && !approvalSent) {
      approvalSent = true;
      const requestId = "approval-1";
      pendingApprovalTurns.set(requestId, { threadId: message.params.threadId, turnId });
      send({ method: "item/commandExecution/requestApproval", id: requestId, params: { threadId: message.params.threadId, turnId, itemId: `command-${turnId}`, command: "printf bridge-ok", reason: "Fake approval check", startedAtMs: Date.now() } });
    } else {
      queueMicrotask(() => completeTurn(message.params.threadId, turnId));
    }
    return;
  }
  if (message.id && !message.method && pendingApprovalTurns.has(message.id)) {
    const pending = pendingApprovalTurns.get(message.id);
    pendingApprovalTurns.delete(message.id);
    if (message.result?.decision === "accept") completeTurn(pending.threadId, pending.turnId);
  }
});
