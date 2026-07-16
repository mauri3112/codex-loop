import path from "node:path";
import type { AgentNode, AuditEvent, ContextBlock, ThreadRecord, Workflow } from "../src/domain/types.js";
import { CodexAppServerClient, type AppServerNotification, type AppServerRequest, textInput } from "./codex-app-server.js";
import { JsonWorkflowStore } from "./store.js";

export interface BridgeStatus {
  state: "disconnected" | "connecting" | "connected" | "failed";
  error?: string;
}

export interface CodexBridgeService {
  status(): BridgeStatus;
  connect(): Promise<BridgeStatus>;
  startWorkflow(workflowId: string, invocation?: RunInvocation): Promise<Workflow>;
  pauseWorkflow(workflowId: string): Promise<Workflow>;
  resumeWorkflow(workflowId: string): Promise<Workflow>;
  stopWorkflow(workflowId: string): Promise<Workflow>;
  resetWorkflow(workflowId: string): Promise<Workflow>;
  sendInstruction(workflowId: string, threadId: string, instruction: string): Promise<Workflow>;
  stopThread(workflowId: string, threadId: string): Promise<Workflow>;
  resolveApproval(workflowId: string, threadId: string, decision: "accept" | "decline"): Promise<Workflow>;
}

export interface RunInvocation {
  source: "manual" | "schedule" | "webhook";
  input?: Record<string, string | number | boolean | null>;
}

interface ThreadLocation { workflowId: string; threadId: string }

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}-${globalThis.crypto.randomUUID()}`;

export class CodexBridge implements CodexBridgeService {
  private bridgeStatus: BridgeStatus = { state: "disconnected" };
  private readonly client: CodexAppServerClient;
  private readonly nativeThreads = new Map<string, ThreadLocation>();
  private readonly launchingNodes = new Set<string>();
  private readonly pendingApprovals = new Map<string, { requestId: string | number; type: "command" | "file-change" }>();

  constructor(private readonly store: JsonWorkflowStore, client = new CodexAppServerClient()) {
    this.client = client;
    this.client.setHandlers({
      onNotification: (notification) => this.handleNotification(notification),
      onRequest: (request) => this.handleRequest(request),
      onStderr: (line) => {
        if (/\b(error|warn)/i.test(line)) console.warn(`[codex app-server] ${line}`);
      },
    });
  }

  close(): Promise<void> {
    return this.client.close();
  }

  status(): BridgeStatus {
    return { ...this.bridgeStatus };
  }

  async connect(): Promise<BridgeStatus> {
    if (this.bridgeStatus.state === "connected") return this.status();
    this.bridgeStatus = { state: "connecting" };
    try {
      await this.client.connect();
      this.bridgeStatus = { state: "connected" };
    } catch (error) {
      this.bridgeStatus = { state: "failed", error: errorMessage(error) };
      throw error;
    }
    return this.status();
  }

  async startWorkflow(workflowId: string, invocation: RunInvocation = { source: "manual" }): Promise<Workflow> {
    await this.connect();
    const workflow = await this.store.mutateWorkflow(workflowId, (draft) => {
      if (["running", "paused"].includes(draft.status)) throw new Error("Workflow is already running");
      const runNumber = draft.runs.length + 1;
      draft.runs.push({
        id: `run-${draft.id}-${runNumber}`,
        status: "running",
        step: 0,
        source: invocation.source,
        ...(invocation.input && Object.keys(invocation.input).length ? { input: invocation.input } : {}),
        startedAt: now(),
      });
      draft.status = "running";
      draft.events = [];
      for (const node of draft.nodes) {
        const hasIncoming = draft.edges.some((edge) => edge.target === node.id);
        node.status = hasIncoming ? "waiting" : "queued";
        node.progress = 0;
        node.attempt = 0;
      }
      for (const edge of draft.edges) edge.status = "idle";
      for (const observer of draft.observers) observer.status = "watching";
      const sourceLabel = invocation.source === "schedule" ? "schedule" : invocation.source === "webhook" ? "webhook" : "Run control";
      addEvent(draft, { kind: "workflow", type: "workflow.started", actor: invocation.source === "manual" ? "You" : "Codex Loop", message: `Workflow started by ${sourceLabel} through the Codex app-server bridge` });
    });
    void this.schedule(workflowId);
    return workflow;
  }

  async pauseWorkflow(workflowId: string): Promise<Workflow> {
    return this.store.mutateWorkflow(workflowId, (workflow) => {
      const run = workflow.runs.at(-1);
      if (run?.status === "running") run.status = "paused";
      workflow.status = "paused";
      addEvent(workflow, { kind: "workflow", type: "workflow.paused", actor: "You", message: "Workflow paused; active Codex turns may finish, but no new nodes will start" });
    });
  }

  async resumeWorkflow(workflowId: string): Promise<Workflow> {
    const workflow = await this.store.mutateWorkflow(workflowId, (draft) => {
      const run = draft.runs.at(-1);
      if (run?.status === "paused") run.status = "running";
      draft.status = "running";
      addEvent(draft, { kind: "workflow", type: "workflow.resumed", actor: "You", message: "Workflow resumed" });
    });
    void this.schedule(workflowId);
    return workflow;
  }

  async stopWorkflow(workflowId: string): Promise<Workflow> {
    const workflow = await this.store.getWorkflow(workflowId);
    await Promise.all(workflow.threads.flatMap((thread) => {
      const nativeId = thread.codex?.threadId;
      const turnId = thread.codex?.activeTurnId;
      return nativeId && turnId ? [this.client.interruptTurn(nativeId, turnId).catch(() => undefined)] : [];
    }));
    return this.store.mutateWorkflow(workflowId, (draft) => {
      const run = draft.runs.at(-1);
      if (run && ["running", "paused"].includes(run.status)) run.status = "stopped";
      draft.status = "stopped";
      for (const node of draft.nodes) {
        if (["running", "queued", "waiting", "retrying", "blocked"].includes(node.status)) node.status = "stopped";
      }
      for (const thread of draft.threads) {
        if (["running", "queued", "waiting", "retrying", "blocked"].includes(thread.status)) thread.status = "stopped";
        if (thread.codex) thread.codex = { ...thread.codex, activeTurnId: undefined, state: "stopped" };
      }
      addEvent(draft, { kind: "workflow", type: "workflow.stopped", actor: "You", message: "Workflow stopped and active Codex turns interrupted" });
    });
  }

  async resetWorkflow(workflowId: string): Promise<Workflow> {
    const workflow = await this.store.getWorkflow(workflowId);
    await Promise.all(workflow.threads.flatMap((thread) => thread.codex?.threadId ? [this.client.archiveThread(thread.codex.threadId).catch(() => undefined)] : []));
    return this.store.mutateWorkflow(workflowId, (draft) => {
      draft.status = draft.nodes.length ? "ready" : "draft";
      draft.contextBlocks = draft.contextBlocks.filter((block) => block.createdBy === "manual");
      for (const node of draft.nodes) {
        node.status = "idle";
        node.progress = 0;
        node.attempt = 0;
        node.readableContextBlockIds = [];
      }
      for (const edge of draft.edges) edge.status = "idle";
      for (const observer of draft.observers) observer.status = "idle";
      for (const thread of draft.threads) {
        if (thread.codex?.threadId) this.nativeThreads.delete(thread.codex.threadId);
        thread.status = "idle";
        thread.toolCalls = [];
        thread.fileChanges = [];
        thread.attempts = [];
        thread.finalOutput = undefined;
        thread.pendingApproval = undefined;
        thread.codex = { state: "disconnected" };
      }
      addEvent(draft, { kind: "workflow", type: "workflow.reset", actor: "You", message: "Workflow reset; prior native Codex threads were archived" });
    });
  }

  async sendInstruction(workflowId: string, threadId: string, instruction: string): Promise<Workflow> {
    const text = instruction.trim();
    if (!text) throw new Error("Instruction cannot be empty");
    await this.connect();
    let workflow = await this.store.getWorkflow(workflowId);
    const localThread = requireThread(workflow, threadId);
    const native = await this.ensureThread(workflow, localThread);

    workflow = await this.store.mutateWorkflow(workflowId, (draft) => {
      const thread = requireThread(draft, threadId);
      const node = draft.nodes.find((candidate) => candidate.id === thread.nodeId);
      thread.messages.push({ id: id("user"), role: "user", content: text, timestamp: now() });
      thread.status = "running";
      thread.codex = { ...thread.codex, threadId: native.threadId, model: native.model, cwd: native.cwd, state: "running" };
      if (node) node.status = "running";
      addEvent(draft, { kind: "thread", type: "thread.instruction-added", actor: "You", message: `Sent an instruction to ${thread.title}`, nodeId: node?.id });
    });

    const current = requireThread(workflow, threadId);
    if (current.codex?.activeTurnId) {
      await this.client.steerTurn(native.threadId, current.codex.activeTurnId, text);
      return workflow;
    }

    const turn = await this.client.startTurn({
      threadId: native.threadId,
      input: [textInput(text)],
      effort: effortFor(workflow.nodes.find((node) => node.id === current.nodeId)),
    });
    return this.store.mutateWorkflow(workflowId, (draft) => {
      const thread = requireThread(draft, threadId);
      const node = draft.nodes.find((candidate) => candidate.id === thread.nodeId);
      thread.codex = { ...thread.codex, threadId: native.threadId, activeTurnId: turn.turn.id, state: "running" };
      const attempt = thread.attempts.length + 1;
      thread.attempts.push({ number: attempt, model: node?.effectiveModel ?? thread.model, status: "running", receivedContextBlockIds: node?.readableContextBlockIds ?? [], summary: "Manual Codex turn in progress" });
    });
  }

  async stopThread(workflowId: string, threadId: string): Promise<Workflow> {
    const workflow = await this.store.getWorkflow(workflowId);
    const thread = requireThread(workflow, threadId);
    if (thread.codex?.threadId && thread.codex.activeTurnId) {
      await this.client.interruptTurn(thread.codex.threadId, thread.codex.activeTurnId);
    }
    return this.store.mutateWorkflow(workflowId, (draft) => {
      const target = requireThread(draft, threadId);
      const node = draft.nodes.find((candidate) => candidate.id === target.nodeId);
      target.status = "stopped";
      target.codex = { ...target.codex, activeTurnId: undefined, state: "stopped" };
      if (node) node.status = "stopped";
      if (draft.status === "running") {
        draft.status = "stopped";
        const run = draft.runs.at(-1);
        if (run?.status === "running") run.status = "stopped";
      }
      addEvent(draft, { kind: "thread", type: "thread.stopped", actor: "You", message: `Stopped ${target.title}`, nodeId: node?.id });
    });
  }

  async resolveApproval(workflowId: string, threadId: string, decision: "accept" | "decline"): Promise<Workflow> {
    const workflow = await this.store.getWorkflow(workflowId);
    const thread = requireThread(workflow, threadId);
    const approval = thread.pendingApproval;
    if (!approval) throw new Error("This thread has no pending approval");
    const pending = this.pendingApprovals.get(String(approval.requestId));
    if (!pending) throw new Error("The approval request is no longer active");
    this.client.respond(pending.requestId, { decision });
    this.pendingApprovals.delete(String(approval.requestId));
    return this.store.mutateWorkflow(workflowId, (draft) => {
      const target = requireThread(draft, threadId);
      target.pendingApproval = undefined;
      addEvent(draft, { kind: "approval", type: decision === "accept" ? "approval.accepted" : "approval.declined", actor: "You", message: `${decision === "accept" ? "Approved" : "Declined"} ${pending.type} request`, nodeId: target.nodeId });
    });
  }

  private async schedule(workflowId: string): Promise<void> {
    const workflow = await this.store.getWorkflow(workflowId);
    if (workflow.status !== "running" || workflow.runs.at(-1)?.status !== "running") return;
    const ready = workflow.nodes.filter((node) => {
      if (!["idle", "queued", "waiting"].includes(node.status)) return false;
      const sources = workflow.edges.filter((edge) => edge.target === node.id).map((edge) => edge.source);
      return sources.every((source) => workflow.nodes.find((candidate) => candidate.id === source)?.status === "completed");
    });
    await Promise.all(ready.map((node) => this.runNode(workflowId, node.id)));
  }

  private async runNode(workflowId: string, nodeId: string): Promise<void> {
    const launchKey = `${workflowId}:${nodeId}`;
    if (this.launchingNodes.has(launchKey)) return;
    this.launchingNodes.add(launchKey);
    try {
      let workflow = await this.store.mutateWorkflow(workflowId, (draft) => {
        const node = requireNode(draft, nodeId);
        const thread = requireThread(draft, node.threadId);
        node.status = "running";
        node.progress = 8;
        node.attempt += 1;
        thread.status = "running";
        thread.codex = { ...thread.codex, state: "starting", lastError: undefined };
        thread.attempts.push({ number: node.attempt, model: node.effectiveModel, status: "running", receivedContextBlockIds: [...node.readableContextBlockIds], summary: "Starting native Codex turn" });
        addEvent(draft, { kind: "agent", type: "node.started", actor: node.name, message: `${node.name} is connecting to a native Codex thread`, nodeId });
      });
      const node = requireNode(workflow, nodeId);
      const thread = requireThread(workflow, node.threadId);
      const native = await this.ensureThread(workflow, thread);
      workflow = await this.store.getWorkflow(workflowId);
      const liveNode = requireNode(workflow, nodeId);
      const turn = await this.client.startTurn({
        threadId: native.threadId,
        input: [textInput(buildNodePrompt(workflow, liveNode))],
        effort: effortFor(liveNode),
        responsesapiClientMetadata: { codex_loop_workflow_id: workflow.id, codex_loop_node_id: nodeId },
      });
      await this.store.mutateWorkflow(workflowId, (draft) => {
        const target = requireThread(draft, liveNode.threadId);
        const targetNode = requireNode(draft, nodeId);
        target.codex = { threadId: native.threadId, activeTurnId: turn.turn.id, model: native.model, cwd: native.cwd, state: "running" };
        targetNode.progress = 15;
        addEvent(draft, { kind: "thread", type: "turn.started", actor: targetNode.name, message: `Native Codex turn ${turn.turn.id.slice(0, 8)} started`, nodeId });
      });
    } catch (error) {
      const retry = await this.failNode(workflowId, nodeId, errorMessage(error));
      if (retry) queueMicrotask(() => { void this.schedule(workflowId); });
    } finally {
      this.launchingNodes.delete(launchKey);
    }
  }

  private async ensureThread(workflow: Workflow, thread: ThreadRecord): Promise<{ threadId: string; model: string; cwd: string }> {
    const cwd = path.resolve(process.env.CODEX_LOOP_WORKSPACE ?? process.cwd());
    const existing = thread.codex?.threadId;
    if (existing) {
      this.nativeThreads.set(existing, { workflowId: workflow.id, threadId: thread.id });
      try {
        const resumed = await this.client.resumeThread(existing, { cwd, excludeTurns: true });
        return { threadId: resumed.thread.id, model: resumed.model, cwd: resumed.cwd };
      } catch {
        this.nativeThreads.delete(existing);
      }
    }

    const model = process.env.CODEX_LOOP_MODEL?.trim();
    const started = await this.client.startThread({
      cwd,
      ...(model ? { model } : {}),
      approvalPolicy: workflow.approvalPolicy === "never" ? "never" : "on-request",
      sandbox: sandboxMode(),
      ephemeral: false,
      developerInstructions: "You are a worker inside a Codex Loop workflow. Complete only the assigned node task, work directly in the configured repository, verify your work, and end with a concise evidence-based result for downstream nodes. Do not create sub-agents.",
    });
    this.nativeThreads.set(started.thread.id, { workflowId: workflow.id, threadId: thread.id });
    await this.client.setThreadName(started.thread.id, `${workflow.name} · ${thread.title}`).catch(() => undefined);
    await this.store.mutateWorkflow(workflow.id, (draft) => {
      const target = requireThread(draft, thread.id);
      target.codex = { threadId: started.thread.id, model: started.model, cwd: started.cwd, state: "idle" };
      addEvent(draft, { kind: "thread", type: "thread.created", actor: "Codex Loop", message: `Created native Codex thread ${started.thread.id.slice(0, 8)} for ${target.title}`, nodeId: target.nodeId });
    });
    return { threadId: started.thread.id, model: started.model, cwd: started.cwd };
  }

  private async handleNotification(notification: AppServerNotification): Promise<void> {
    const nativeId = stringValue(notification.params.threadId);
    if (!nativeId) return;
    const location = this.nativeThreads.get(nativeId);
    if (!location) return;

    if (notification.method === "item/agentMessage/delta") {
      await this.updateAssistantDelta(location, stringValue(notification.params.itemId), stringValue(notification.params.delta));
      return;
    }
    if (notification.method === "item/started" || notification.method === "item/completed") {
      await this.updateItem(location, asRecord(notification.params.item), notification.method === "item/completed");
      return;
    }
    if (notification.method === "turn/started") {
      const turn = asRecord(notification.params.turn);
      await this.store.mutateWorkflow(location.workflowId, (workflow) => {
        const thread = requireThread(workflow, location.threadId);
        thread.codex = { ...thread.codex, threadId: nativeId, activeTurnId: stringValue(turn.id), state: "running" };
      });
      return;
    }
    if (notification.method === "turn/completed") {
      await this.completeTurn(location, asRecord(notification.params.turn));
      return;
    }
    if (notification.method === "error") {
      await this.store.mutateWorkflow(location.workflowId, (workflow) => {
        const thread = requireThread(workflow, location.threadId);
        thread.codex = { ...thread.codex, state: "failed", lastError: stringValue(notification.params.message) || "Codex app-server error" };
      });
    }
  }

  private async handleRequest(request: AppServerRequest): Promise<void> {
    const nativeId = stringValue(request.params.threadId);
    const location = nativeId ? this.nativeThreads.get(nativeId) : undefined;
    const type = request.method === "item/commandExecution/requestApproval" ? "command" : request.method === "item/fileChange/requestApproval" ? "file-change" : undefined;
    if (!location || !type) {
      this.client.respondError(request.id, -32601, `Codex Loop does not handle ${request.method}`);
      return;
    }
    this.pendingApprovals.set(String(request.id), { requestId: request.id, type });
    await this.store.mutateWorkflow(location.workflowId, (workflow) => {
      const thread = requireThread(workflow, location.threadId);
      thread.pendingApproval = {
        requestId: request.id,
        type,
        command: stringValue(request.params.command) || undefined,
        reason: stringValue(request.params.reason) || undefined,
      };
      addEvent(workflow, { kind: "approval", type: "approval.requested", actor: thread.title, message: `${thread.title} requested ${type} approval`, nodeId: thread.nodeId });
    });
  }

  private async updateAssistantDelta(location: ThreadLocation, itemId: string, delta: string): Promise<void> {
    if (!itemId || !delta) return;
    await this.store.mutateWorkflow(location.workflowId, (workflow) => {
      const thread = requireThread(workflow, location.threadId);
      const existing = thread.messages.find((message) => message.id === itemId);
      if (existing) existing.content += delta;
      else thread.messages.push({ id: itemId, role: "assistant", content: delta, timestamp: now() });
      const node = workflow.nodes.find((candidate) => candidate.id === thread.nodeId);
      if (node) node.progress = Math.min(90, Math.max(node.progress, 35));
    });
  }

  private async updateItem(location: ThreadLocation, item: Record<string, unknown>, completed: boolean): Promise<void> {
    const itemType = stringValue(item.type);
    const itemId = stringValue(item.id);
    if (!itemId) return;
    await this.store.mutateWorkflow(location.workflowId, (workflow) => {
      const thread = requireThread(workflow, location.threadId);
      if (itemType === "agentMessage") {
        const text = stringValue(item.text);
        const existing = thread.messages.find((message) => message.id === itemId);
        if (existing) existing.content = text || existing.content;
        else if (text) thread.messages.push({ id: itemId, role: "assistant", content: text, timestamp: now() });
        if (completed && text) thread.finalOutput = text;
        return;
      }
      if (["commandExecution", "mcpToolCall", "dynamicToolCall"].includes(itemType)) {
        const tool = thread.toolCalls.find((candidate) => candidate.id === itemId);
        const status = toolStatus(stringValue(item.status), completed);
        const name = itemType === "commandExecution" ? "Command" : itemType === "mcpToolCall" ? `${stringValue(item.server)} · ${stringValue(item.tool)}` : stringValue(item.tool) || "Tool";
        const command = itemType === "commandExecution" ? stringValue(item.command) : JSON.stringify(item.arguments ?? {});
        const output = itemType === "commandExecution" ? stringValue(item.aggregatedOutput) : JSON.stringify(item.result ?? item.contentItems ?? item.error ?? "");
        if (tool) Object.assign(tool, { name, command, output, status });
        else thread.toolCalls.push({ id: itemId, name, command, output, status });
        addEvent(workflow, { kind: "tool", type: completed ? `tool.${status}` : "tool.started", actor: thread.title, message: `${name} ${completed ? status : "started"}`, nodeId: thread.nodeId });
        return;
      }
      if (itemType === "fileChange" && completed) {
        const changes = Array.isArray(item.changes) ? item.changes.map(asRecord) : [];
        for (const change of changes) {
          const filePath = stringValue(change.path);
          const diff = stringValue(change.diff);
          const counts = diffCounts(diff);
          const kind = stringValue(asRecord(change.kind).type) || "update";
          const next = { path: filePath, additions: counts.additions, deletions: counts.deletions, summary: `${kind} applied by native Codex thread` };
          const index = thread.fileChanges.findIndex((candidate) => candidate.path === filePath);
          if (index >= 0) thread.fileChanges[index] = next;
          else thread.fileChanges.push(next);
        }
        addEvent(workflow, { kind: "file", type: "file.changed", actor: thread.title, message: `Codex changed ${changes.length} file${changes.length === 1 ? "" : "s"}`, nodeId: thread.nodeId });
      }
    });
  }

  private async completeTurn(location: ThreadLocation, turn: Record<string, unknown>): Promise<void> {
    const status = stringValue(turn.status);
    const error = stringValue(asRecord(turn.error).message);
    const workflow = await this.store.mutateWorkflow(location.workflowId, (draft) => {
      const thread = requireThread(draft, location.threadId);
      const node = draft.nodes.find((candidate) => candidate.id === thread.nodeId);
      const attempt = thread.attempts.at(-1);
      thread.codex = { ...thread.codex, activeTurnId: undefined, state: status === "completed" ? "idle" : status === "interrupted" ? "stopped" : "failed", lastError: error || undefined };
      if (status === "completed") {
        thread.status = "completed";
        if (attempt?.status === "running") {
          attempt.status = "completed";
          attempt.summary = "Native Codex turn completed";
        }
        if (node) {
          node.status = "completed";
          node.progress = 100;
          const outgoing = draft.edges.filter((candidate) => candidate.source === node.id);
          const targetIds = outgoing.map((edge) => edge.target);
          for (const edge of outgoing) {
            edge.status = "satisfied";
          }
          if (targetIds.length) {
            const block = resultContext(draft, node, thread, targetIds);
            if (!draft.contextBlocks.some((candidate) => candidate.id === block.id)) draft.contextBlocks.push(block);
            for (const target of draft.nodes.filter((candidate) => targetIds.includes(candidate.id))) {
              if (!target.readableContextBlockIds.includes(block.id)) target.readableContextBlockIds.push(block.id);
            }
          }
          addEvent(draft, { kind: "agent", type: "node.completed", actor: node.name, message: `${node.name} completed in native Codex`, nodeId: node.id });
        }
      } else {
        thread.status = status === "interrupted" ? "stopped" : "failed";
        if (attempt?.status === "running") {
          attempt.status = status === "interrupted" ? "stopped" : "failed";
          attempt.summary = error || `Codex turn ${status}`;
        }
        if (node) {
          const retry = status === "failed" && draft.status === "running" && node.attempt < node.retryPolicy.maxAttempts;
          node.status = retry ? "queued" : status === "interrupted" ? "stopped" : "failed";
          thread.status = retry ? "retrying" : thread.status;
          if (retry) {
            addEvent(draft, { kind: "agent", type: "node.retrying", actor: node.name, message: `Native Codex turn failed; scheduling retry ${node.attempt + 1} of ${node.retryPolicy.maxAttempts}`, nodeId: node.id });
          } else if (status === "failed") {
            draft.status = "failed";
            const run = draft.runs.at(-1);
            if (run?.status === "running") run.status = "stopped";
          }
        }
        addEvent(draft, { kind: "agent", type: `node.${status || "failed"}`, actor: node?.name ?? thread.title, message: error || `Codex turn ${status || "failed"}`, nodeId: node?.id });
      }
      finishWorkflowIfDone(draft);
    });
    if (workflow.status === "running") void this.schedule(workflow.id);
  }

  private async failNode(workflowId: string, nodeId: string, message: string): Promise<boolean> {
    let retry = false;
    await this.store.mutateWorkflow(workflowId, (workflow) => {
      const node = requireNode(workflow, nodeId);
      const thread = requireThread(workflow, node.threadId);
      retry = workflow.status === "running" && node.attempt < node.retryPolicy.maxAttempts;
      node.status = retry ? "queued" : "failed";
      thread.status = retry ? "retrying" : "failed";
      thread.codex = { ...thread.codex, activeTurnId: undefined, state: retry ? "idle" : "failed", lastError: message };
      const attempt = thread.attempts.at(-1);
      if (attempt?.status === "running") {
        attempt.status = "failed";
        attempt.summary = message;
      }
      if (!retry) {
        workflow.status = "failed";
        const run = workflow.runs.at(-1);
        if (run?.status === "running") run.status = "stopped";
      }
      addEvent(workflow, { kind: "agent", type: retry ? "node.retrying" : "node.failed", actor: node.name, message: retry ? `${message}; retrying` : message, nodeId });
    });
    return retry;
  }
}

function buildNodePrompt(workflow: Workflow, node: AgentNode): string {
  const blocks = workflow.contextBlocks.filter((block) => node.readableContextBlockIds.includes(block.id) || block.allowedAgentNodeIds.includes(node.id));
  const context = blocks.length ? blocks.map((block) => `- ${block.title}: ${block.summary}`).join("\n") : "- No shared context was granted to this node.";
  const run = workflow.runs.at(-1);
  const runInput = run?.input && Object.keys(run.input).length
    ? `Run input values (${run.source ?? "manual"}):\n${JSON.stringify(run.input, null, 2)}`
    : `Run source: ${run?.source ?? "manual"}`;
  return [
    `Parent workflow: ${workflow.name}`,
    `Workflow objective: ${workflow.mainTask}`,
    `Your assigned node: ${node.name}`,
    `Task: ${node.task}`,
    `Definition of done: ${node.definitionOfDone}`,
    runInput,
    "Shared context explicitly granted to you:",
    context,
    "Complete this task in the current repository. Use tools as needed, verify the result, and finish with a concise handoff summary for downstream nodes.",
  ].join("\n\n");
}

function resultContext(workflow: Workflow, node: AgentNode, thread: ThreadRecord, targetIds: string[]): ContextBlock {
  return {
    id: `codex-result-${node.id}-${node.attempt}`,
    title: `${node.name} result`,
    summary: (thread.finalOutput || `${node.name} completed successfully.`).slice(0, 2_000),
    category: node.role === "tester" ? "test-results" : node.role === "implementer" ? "changed-files" : "repository-finding",
    sourceThreadId: thread.id,
    createdBy: "agent",
    allowedAgentNodeIds: targetIds,
    estimatedTokens: Math.ceil((thread.finalOutput?.length ?? 40) / 4),
    createdAt: now(),
    position: { x: node.position.x + 120, y: node.position.y + 30 },
  };
}

function finishWorkflowIfDone(workflow: Workflow): void {
  if (workflow.status === "completed") return;
  if (!workflow.nodes.length || !workflow.nodes.every((node) => node.status === "completed")) return;
  workflow.status = "completed";
  const run = workflow.runs.at(-1);
  if (run) {
    run.status = "completed";
    run.completedAt = now();
  }
  addEvent(workflow, { kind: "workflow", type: "workflow.completed", actor: "Codex Loop", message: `Workflow completed through ${workflow.nodes.length} native Codex threads` });
}

function addEvent(workflow: Workflow, input: Omit<AuditEvent, "id" | "sequence" | "runId" | "timestamp" | "logicalTime">): void {
  const run = workflow.runs.at(-1);
  if (run) run.step += 1;
  workflow.events.push({
    ...input,
    id: id("event"),
    sequence: workflow.events.length + 1,
    runId: run?.id ?? "manual",
    timestamp: now(),
    logicalTime: run?.step ?? 0,
  });
}

function requireThread(workflow: Workflow, threadId: string): ThreadRecord {
  const thread = workflow.threads.find((candidate) => candidate.id === threadId);
  if (!thread) throw new Error(`Thread ${threadId} was not found in workflow ${workflow.id}`);
  return thread;
}

function requireNode(workflow: Workflow, nodeId: string): AgentNode {
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Node ${nodeId} was not found in workflow ${workflow.id}`);
  return node;
}

function sandboxMode(): "read-only" | "workspace-write" | "danger-full-access" {
  const value = process.env.CODEX_LOOP_SANDBOX;
  return value === "read-only" || value === "danger-full-access" ? value : "workspace-write";
}

function effortFor(node?: AgentNode): string | undefined {
  if (!node?.reasoningEffort) return undefined;
  return node.reasoningEffort === "max" ? "xhigh" : node.reasoningEffort;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Codex bridge error";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function toolStatus(value: string, completed: boolean): "running" | "failed" | "completed" {
  if (!completed || value === "inProgress") return "running";
  return value === "completed" ? "completed" : "failed";
}

function diffCounts(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}
