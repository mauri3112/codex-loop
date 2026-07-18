import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
let threadSequence = 0;
let turnSequence = 0;
let approvalSent = false;
let userInputSent = false;
const pendingApprovalTurns = new Map();
const pendingInputTurns = new Map();

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

function completeTurn(threadId, turnId) {
  const command = { type: "commandExecution", id: `command-${turnId}`, command: "printf bridge-ok", cwd: process.cwd(), processId: null, source: "agent", status: "completed", commandActions: [], aggregatedOutput: "bridge-ok", exitCode: 0, durationMs: 1 };
  const agent = { type: "agentMessage", id: `message-${turnId}`, text: process.env.FAKE_AGENT_OUTPUT || `Native result for ${threadId}`, phase: "final_answer", memoryCitation: null };
  send({ method: "item/started", params: { threadId, turnId, item: { ...command, status: "inProgress" }, startedAtMs: Date.now() } });
  send({ method: "item/completed", params: { threadId, turnId, item: command, completedAtMs: Date.now() } });
  send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: agent.id, delta: agent.text } });
  send({ method: "item/completed", params: { threadId, turnId, item: agent, completedAtMs: Date.now() } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [command, agent], itemsView: "full", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1 } } });
}

function failTurn(threadId, turnId) {
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "full", status: "failed", error: { message: "Fake terminal failure" }, startedAt: 1, completedAt: 2, durationMs: 1 } } });
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
    if (process.env.FAKE_TOKEN_TOTAL) {
      const totalTokens = Number(process.env.FAKE_TOKEN_TOTAL);
      const breakdown = { inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens };
      send({ method: "thread/tokenUsage/updated", params: { threadId: message.params.threadId, turnId, tokenUsage: { total: breakdown, last: breakdown, modelContextWindow: 258400 } } });
    }
    if (process.env.FAKE_TURN_FAILURE === "1") {
      queueMicrotask(() => failTurn(message.params.threadId, turnId));
    } else if (process.env.FAKE_APPROVAL === "1" && !approvalSent) {
      approvalSent = true;
      const requestId = "approval-1";
      pendingApprovalTurns.set(requestId, { threadId: message.params.threadId, turnId });
      send({ method: "item/commandExecution/requestApproval", id: requestId, params: { threadId: message.params.threadId, turnId, itemId: `command-${turnId}`, command: "printf bridge-ok", reason: "Fake approval check", startedAtMs: Date.now() } });
    } else if (process.env.FAKE_USER_INPUT === "1" && !userInputSent) {
      userInputSent = true;
      const requestId = "user-input-1";
      pendingInputTurns.set(requestId, { threadId: message.params.threadId, turnId });
      send({ method: "item/tool/requestUserInput", id: requestId, params: { threadId: message.params.threadId, turnId, itemId: `request-${turnId}`, autoResolutionMs: null, questions: [
        { id: "choice", header: "Choose", question: "Which path should Codex take?", isOther: true, isSecret: false, options: [{ label: "Safe", description: "Use the safe path" }] },
        { id: "token", header: "Secret", question: "Provide a temporary token", isOther: false, isSecret: true, options: null },
      ] } });
      if (process.env.FAKE_EXIT_AFTER_INPUT === "1") setTimeout(() => process.exit(23), 25);
    } else {
      const delay = Number(process.env.FAKE_TURN_DELAY_MS ?? 0);
      if (delay > 0) setTimeout(() => completeTurn(message.params.threadId, turnId), delay);
      else queueMicrotask(() => completeTurn(message.params.threadId, turnId));
    }
    return;
  }
  if (message.id && !message.method && pendingApprovalTurns.has(message.id)) {
    const pending = pendingApprovalTurns.get(message.id);
    pendingApprovalTurns.delete(message.id);
    if (message.result?.decision === "accept") completeTurn(pending.threadId, pending.turnId);
    return;
  }
  if (message.id && !message.method && pendingInputTurns.has(message.id)) {
    const pending = pendingInputTurns.get(message.id);
    pendingInputTurns.delete(message.id);
    if (Array.isArray(message.result?.answers?.choice?.answers) && Array.isArray(message.result?.answers?.token?.answers)) {
      send({ method: "serverRequest/resolved", params: { threadId: pending.threadId, requestId: message.id } });
      completeTurn(pending.threadId, pending.turnId);
    }
  }
});
