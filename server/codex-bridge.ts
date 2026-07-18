import path from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { AgentNode, AttentionQuestion, AuditEvent, ContextBlock, InterventionDelivery, ThreadRecord, Workflow } from "../src/domain/types.js";
import type { TaskCapabilitiesResponse, TaskCapability } from "../src/domain/task-capabilities.js";
import { validateWorkflowDefinition, workflowDefinition } from "../src/domain/definition.js";
import { CodexAppServerClient, type AppServerNotification, type AppServerRequest, textInput } from "./codex-app-server.js";
import { JsonWorkflowStore } from "./store.js";

export interface BridgeStatus {
  state: "disconnected" | "connecting" | "connected" | "failed";
  error?: string;
}

export interface CodexBridgeService {
  status(): BridgeStatus;
  connect(): Promise<BridgeStatus>;
  listTaskCapabilities?(): Promise<TaskCapabilitiesResponse>;
  startWorkflow(workflowId: string, invocation?: RunInvocation): Promise<Workflow>;
  pauseWorkflow(workflowId: string): Promise<Workflow>;
  resumeWorkflow(workflowId: string): Promise<Workflow>;
  stopWorkflow(workflowId: string): Promise<Workflow>;
  resetWorkflow(workflowId: string): Promise<Workflow>;
  sendInstruction(workflowId: string, threadId: string, instruction: string): Promise<Workflow>;
  stopThread(workflowId: string, threadId: string): Promise<Workflow>;
  resolveApproval(workflowId: string, threadId: string, decision: "accept" | "decline"): Promise<Workflow>;
  submitIntervention(workflowId: string, input: InterventionInput): Promise<Workflow>;
  respondToAttention(workflowId: string, attentionId: string, input: AttentionResponseInput): Promise<Workflow>;
  resolveGate?(workflowId: string, nodeId: string, decision: "approve" | "decline"): Promise<Workflow>;
}

export interface InterventionInput {
  runId: string;
  idempotencyKey: string;
  delivery: InterventionDelivery;
  message: string;
  threadId?: string;
  expectedTurnId?: string;
  recipientNodeIds?: string[];
}

export interface AttentionResponseInput {
  runId: string;
  expectedTurnId?: string;
  answers: Record<string, string | string[]>;
}

export class BridgeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeConflictError";
  }
}

export class BridgeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeInputError";
  }
}

export class BridgeResourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeResourceNotFoundError";
  }
}

export interface RunInvocation {
  source: "manual" | "schedule" | "webhook";
  input?: Record<string, string | number | boolean | null>;
  parentRun?: { workflowId: string; nodeId: string };
}

interface SkillsListResponse {
  data: Array<{
    skills: Array<{
      name: string;
      description: string;
      shortDescription?: string | null;
      enabled: boolean;
      interface?: { displayName?: string | null; shortDescription?: string | null } | null;
    }>;
  }>;
}

interface McpServerStatusResponse {
  data: Array<{
    name: string;
    tools: Record<string, unknown>;
    serverInfo?: { title?: string | null; description?: string | null } | null;
    authStatus?: "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth";
  }>;
}

interface AppListResponse {
  data: Array<{
    id: string;
    name: string;
    description?: string | null;
    isAccessible: boolean;
    isEnabled: boolean;
  }>;
}

interface ThreadLocation { workflowId: string; threadId: string }

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}-${globalThis.crypto.randomUUID()}`;
const execFileAsync = promisify(execFile);

export class CodexBridge implements CodexBridgeService {
  private bridgeStatus: BridgeStatus = { state: "disconnected" };
  private readonly client: CodexAppServerClient;
  private readonly nativeThreads = new Map<string, ThreadLocation>();
  private readonly launchingNodes = new Set<string>();
  private readonly schedulingWorkflows = new Set<string>();
  private readonly scheduleAgain = new Set<string>();
  private readonly pendingApprovals = new Map<string, { requestId: string | number; type: "command" | "file-change" }>();
  private readonly pendingUserInputs = new Map<string, { requestId: string | number; workflowId: string; attentionId: string }>();
  private readonly operationQueues = new Map<string, Promise<unknown>>();
  private readonly tokenUsageTotals = new Map<string, number>();
  private runtimePrepared = false;

  constructor(private readonly store: JsonWorkflowStore, client = new CodexAppServerClient()) {
    this.client = client;
    this.client.setHandlers({
      onNotification: (notification) => this.handleNotification(notification),
      onRequest: (request) => this.handleRequest(request),
      onExit: (error) => this.handleAppServerExit(error),
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

  async listTaskCapabilities(): Promise<TaskCapabilitiesResponse> {
    await this.connect();
    const warnings: string[] = [];
    const [skillsResult, mcpResult, appsResult, githubCliResult] = await Promise.allSettled([
      this.client.request<SkillsListResponse>("skills/list", { cwds: [process.cwd()] }),
      this.client.request<McpServerStatusResponse>("mcpServerStatus/list", { detail: "toolsAndAuthOnly", limit: 100 }),
      this.client.request<AppListResponse>("app/list", { limit: 100 }),
      execFileAsync("gh", ["auth", "status"], { timeout: 5_000, env: scrubbedCapabilityProbeEnvironment() }),
    ]);
    const items: TaskCapability[] = [];

    if (skillsResult.status === "fulfilled") {
      const seen = new Set<string>();
      for (const skill of skillsResult.value.data.flatMap((entry) => entry.skills)) {
        if (!skill.enabled || seen.has(skill.name)) continue;
        seen.add(skill.name);
        const isComputerUse = /computer[\s_-]*use/i.test(`${skill.name} ${skill.interface?.displayName ?? ""}`);
        items.push({
          id: `${isComputerUse ? "computer-use" : "skill"}:${skill.name}`,
          kind: isComputerUse ? "computer-use" : "skill",
          label: skill.interface?.displayName?.trim() || (isComputerUse ? "Computer use" : skill.name),
          description: skill.interface?.shortDescription?.trim() || skill.shortDescription?.trim() || skill.description.trim(),
          invocation: `$${skill.name} `,
          available: true,
        });
      }
    } else {
      warnings.push(`Skills unavailable: ${errorMessage(skillsResult.reason)}`);
    }

    if (mcpResult.status === "fulfilled") {
      for (const server of mcpResult.value.data) {
        const label = server.serverInfo?.title?.trim() || server.name;
        const toolCount = Object.keys(server.tools).length;
        items.push({
          id: `mcp:${server.name}`,
          kind: "mcp",
          label,
          description: server.serverInfo?.description?.trim() || `${toolCount} MCP ${toolCount === 1 ? "tool" : "tools"} available`,
          invocation: `Use the ${label} MCP server to `,
          available: server.authStatus !== "notLoggedIn",
          authStatus: server.authStatus ?? "unknown",
        });
      }
    } else {
      warnings.push(`MCP servers unavailable: ${errorMessage(mcpResult.reason)}`);
    }

    if (appsResult.status === "fulfilled") {
      for (const app of appsResult.value.data) {
        items.push({
          id: `app:${app.id}`,
          kind: "app",
          label: app.name,
          description: app.description?.trim() || `${app.name} app capability`,
          invocation: `Use the ${app.name} app to `,
          available: app.isAccessible && app.isEnabled,
          authStatus: app.isAccessible ? "verified" : "notLoggedIn",
        });
      }
    } else {
      warnings.push(`Apps unavailable: ${errorMessage(appsResult.reason)}`);
    }

    items.push({ id: "shell:codex", kind: "shell", label: "Terminal", description: "Run approved commands in the Loop workspace", invocation: "Use the terminal to ", available: true, authStatus: "verified" });
    if (githubCliResult.status === "fulfilled") {
      items.push({ id: "cli:gh", kind: "cli", label: "GitHub CLI", description: "Authenticated GitHub CLI in this Loop runtime", invocation: "Use GitHub CLI to ", available: true, authStatus: "verified" });
    }

    return { items, source: "codex", ...(warnings.length ? { warnings } : {}) };
  }

  async connect(): Promise<BridgeStatus> {
    if (this.bridgeStatus.state === "connected") return this.status();
    this.bridgeStatus = { state: "connecting" };
    try {
      await this.prepareRuntime();
      await this.client.connect();
      this.bridgeStatus = { state: "connected" };
    } catch (error) {
      this.bridgeStatus = { state: "failed", error: errorMessage(error) };
      throw error;
    }
    return this.status();
  }

  async prepareRuntime(): Promise<void> {
    if (this.runtimePrepared) return;
    await this.expireStaleInputRequests();
    this.runtimePrepared = true;
  }

  async startWorkflow(workflowId: string, invocation: RunInvocation = { source: "manual" }): Promise<Workflow> {
    const candidate = await this.store.getWorkflow(workflowId);
    if (candidate.lifecycle !== "published") throw new BridgeInputError("Publish this Loop revision before starting it");
    await this.connect();
    const repositoryRevision = await currentRepositoryRevision();
    const workflow = await this.store.mutateWorkflow(workflowId, (draft) => {
      if (["running", "paused"].includes(draft.status)) throw new Error("Workflow is already running");
      if (draft.lifecycle !== "published") throw new BridgeInputError("Publish this Loop revision before starting it");
      draft.validationIssues = validateWorkflowDefinition(workflowDefinition(draft));
      if (draft.validationIssues.some((issue) => issue.severity === "error")) throw new BridgeInputError("Resolve Loop validation errors before starting");
      if (draft.capabilityBindings.some((binding) => binding.status !== "available")) throw new BridgeInputError("Resolve required capability bindings before starting");
      if (draft.secretRequirements.some((secret) => secret.status !== "bound")) throw new BridgeInputError("Bind required secrets before starting");
      const runNumber = draft.runs.length + 1;
      const run: Workflow["runs"][number] = {
        id: `run-${draft.id}-${runNumber}`,
        status: "running",
        step: 0,
        source: invocation.source,
        workflowRevision: draft.revision,
        repositoryRevision,
        consumedAgents: 0,
        consumedIterations: 0,
        consumedTokens: 0,
        noProgressRounds: 0,
        checkpoints: [],
        parentRun: invocation.parentRun,
        ...(invocation.input && Object.keys(invocation.input).length ? { input: invocation.input } : {}),
        startedAt: now(),
      };
      const priorCheckpoints = draft.runs.flatMap((candidate) => candidate.checkpoints ?? []);
      draft.runs.push(run);
      draft.status = "running";
      draft.events = [];
      for (const node of draft.nodes) {
        const hasIncoming = draft.edges.some((edge) => edge.target === node.id);
        const cacheKey = checkpointCacheKey(draft, node, run);
        const checkpoint = [...priorCheckpoints].reverse().find((candidate) => candidate.cacheKey === cacheKey && candidate.status === "completed");
        node.status = checkpoint ? "completed" : hasIncoming ? "waiting" : "queued";
        node.progress = checkpoint ? 100 : 0;
        node.attempt = checkpoint ? node.attempt : 0;
        if (checkpoint) {
          run.checkpoints?.push({ ...checkpoint, id: id("checkpoint"), createdAt: now() });
          const thread = draft.threads.find((candidate) => candidate.nodeId === node.id);
          if (thread) { thread.status = "completed"; thread.finalOutput = checkpoint.outputSummary; }
        }
      }
      for (const edge of draft.edges) edge.status = draft.nodes.find((node) => node.id === edge.source)?.status === "completed" ? "satisfied" : "idle";
      for (const observer of draft.observers) observer.status = "watching";
      for (const attention of draft.attentionRequests.filter((candidate) => candidate.status === "open")) {
        attention.status = "expired";
        attention.resolvedAt = now();
      }
      for (const intervention of draft.interventions.filter((candidate) => candidate.status === "pending")) {
        intervention.status = "failed";
        intervention.error = "Superseded by a new workflow run";
      }
      const sourceLabel = invocation.source === "schedule" ? "schedule" : invocation.source === "webhook" ? "webhook" : "Run control";
      addEvent(draft, { kind: "workflow", type: "workflow.started", actor: invocation.source === "manual" ? "You" : "Codex Loop", message: `Workflow started by ${sourceLabel} through the Codex app-server bridge` });
    });
    void this.schedule(workflowId);
    return workflow;
  }

  async pauseWorkflow(workflowId: string): Promise<Workflow> {
    return this.withWorkflowOperation(workflowId, () => this.pauseWorkflowUnlocked(workflowId));
  }

  private async pauseWorkflowUnlocked(workflowId: string): Promise<Workflow> {
    return this.store.mutateWorkflow(workflowId, (workflow) => {
      const run = workflow.runs.at(-1);
      if (run?.status === "running") run.status = "paused";
      workflow.status = "paused";
      addEvent(workflow, { kind: "workflow", type: "workflow.paused", actor: "You", message: "Workflow paused; active Codex turns may finish, but no new nodes will start" });
    });
  }

  async resumeWorkflow(workflowId: string): Promise<Workflow> {
    return this.withWorkflowOperation(workflowId, () => this.resumeWorkflowUnlocked(workflowId));
  }

  private async resumeWorkflowUnlocked(workflowId: string): Promise<Workflow> {
    const workflow = await this.store.mutateWorkflow(workflowId, (draft) => {
      const run = draft.runs.at(-1);
      if (run?.status === "paused") run.status = "running";
      draft.status = "running";
      addEvent(draft, { kind: "workflow", type: "workflow.resumed", actor: "You", message: "Workflow resumed" });
    });
    void this.deliverPendingInterventions(workflowId).finally(() => this.schedule(workflowId));
    return workflow;
  }

  async stopWorkflow(workflowId: string): Promise<Workflow> {
    return this.withWorkflowOperation(workflowId, () => this.stopWorkflowUnlocked(workflowId));
  }

  private async stopWorkflowUnlocked(workflowId: string): Promise<Workflow> {
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
      expireOpenAttention(draft, "Workflow stopped");
      failPendingInterventions(draft, "Workflow stopped before delivery");
      addEvent(draft, { kind: "workflow", type: "workflow.stopped", actor: "You", message: "Workflow stopped and active Codex turns interrupted" });
    });
  }

  async resetWorkflow(workflowId: string): Promise<Workflow> {
    return this.withWorkflowOperation(workflowId, () => this.resetWorkflowUnlocked(workflowId));
  }

  private async resetWorkflowUnlocked(workflowId: string): Promise<Workflow> {
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
        thread.lastActivityAt = undefined;
        thread.codex = { state: "disconnected" };
      }
      expireOpenAttention(draft, "Workflow reset");
      failPendingInterventions(draft, "Workflow reset before delivery");
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
      thread.lastActivityAt = now();
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
      thread.lastActivityAt = now();
      const attempt = thread.attempts.length + 1;
      thread.attempts.push({ number: attempt, model: node?.effectiveModel ?? thread.model, status: "running", receivedContextBlockIds: node?.readableContextBlockIds ?? [], summary: "Manual Codex turn in progress" });
    });
  }

  async stopThread(workflowId: string, threadId: string): Promise<Workflow> {
    return this.withWorkflowOperation(workflowId, () => this.stopThreadUnlocked(workflowId, threadId));
  }

  private async stopThreadUnlocked(workflowId: string, threadId: string): Promise<Workflow> {
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
      expireOpenAttention(draft, `Stopped ${target.title}`);
      failPendingInterventions(draft, `Stopped ${target.title} before delivery`);
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

  async submitIntervention(workflowId: string, input: InterventionInput): Promise<Workflow> {
    return this.withWorkflowOperation(workflowId, async () => {
      const message = input.message.trim();
      if (!message) throw new Error("Intervention message cannot be empty");
      let workflow = await this.store.getWorkflow(workflowId);
      const duplicate = workflow.interventions.find((record) => record.idempotencyKey === input.idempotencyKey);
      if (duplicate) {
        if (!sameInterventionPayload(duplicate, input, message)) throw new BridgeConflictError("This idempotency key was already used for a different intervention");
        return workflow;
      }
      requireCurrentRun(workflow, input.runId, input.delivery !== "context");

      if (input.delivery === "context") {
        const recipientNodeIds = Array.from(new Set(input.recipientNodeIds ?? []));
        if (!recipientNodeIds.length) throw new BridgeInputError("Context interventions require at least one recipient node");
        for (const nodeId of recipientNodeIds) {
          if (!workflow.nodes.some((node) => node.id === nodeId)) throw new BridgeInputError(`Recipient node ${nodeId} was not found`);
        }
        return this.store.mutateWorkflow(workflowId, (draft) => {
          requireCurrentRun(draft, input.runId, false);
          const createdAt = now();
          const recordId = id("intervention");
          const block: ContextBlock = {
            id: `manual-context-${recordId}`,
            title: "User intervention",
            summary: message,
            category: "constraint",
            createdBy: "manual",
            allowedAgentNodeIds: recipientNodeIds,
            estimatedTokens: Math.ceil(message.length / 4),
            createdAt,
            position: contextPosition(draft, recipientNodeIds),
          };
          draft.contextBlocks.push(block);
          for (const node of draft.nodes.filter((candidate) => recipientNodeIds.includes(candidate.id))) {
            if (!node.readableContextBlockIds.includes(block.id)) node.readableContextBlockIds.push(block.id);
          }
          draft.interventions.push({
            id: recordId,
            idempotencyKey: input.idempotencyKey,
            runId: input.runId,
            delivery: "context",
            status: "delivered",
            message,
            recipientNodeIds,
            createdAt,
            deliveredAt: createdAt,
          });
          addEvent(draft, { kind: "intervention", type: "intervention.context-delivered", actor: "You", message: `Shared intervention context with ${recipientNodeIds.length} node${recipientNodeIds.length === 1 ? "" : "s"}`, contextBlockId: block.id });
        });
      }

      if (!input.threadId) throw new BridgeInputError(`${input.delivery} interventions require a threadId`);
      const thread = workflow.threads.find((candidate) => candidate.id === input.threadId);
      if (!thread) throw new BridgeInputError(`Target thread ${input.threadId} was not found`);
      const activeTurnId = thread.codex?.activeTurnId;
      if (input.delivery === "steer") {
        if (!activeTurnId || !input.expectedTurnId) throw new BridgeConflictError("The target thread no longer has an active turn; queue the intervention instead");
        if (activeTurnId !== input.expectedTurnId) throw new BridgeConflictError("The target turn changed before the intervention was submitted");
      } else if (!activeTurnId || !input.expectedTurnId) {
        throw new BridgeConflictError("Queue interventions require an active turn; refresh and choose an active agent");
      } else if (activeTurnId !== input.expectedTurnId) {
        throw new BridgeConflictError("The active turn changed; refresh before queueing this intervention");
      }

      const createdAt = now();
      workflow = await this.store.mutateWorkflow(workflowId, (draft) => {
        requireCurrentRun(draft, input.runId);
        const liveThread = requireThread(draft, input.threadId as string);
        const liveTurnId = liveThread.codex?.activeTurnId;
        if (input.delivery === "steer") {
          if (!liveTurnId || liveTurnId !== input.expectedTurnId) throw new BridgeConflictError("The target turn changed before the intervention was delivered");
        } else if (liveTurnId !== input.expectedTurnId) {
          throw new BridgeConflictError("The target turn changed before the intervention was queued");
        }
        draft.interventions.push({
          id: id("intervention"),
          idempotencyKey: input.idempotencyKey,
          runId: input.runId,
          delivery: input.delivery,
          status: input.delivery === "queue" ? "pending" : "delivered",
          message,
          threadId: input.threadId,
          expectedTurnId: input.expectedTurnId,
          createdAt,
          ...(input.delivery === "steer" ? { deliveredAt: createdAt } : {}),
        });
        addEvent(draft, {
          kind: "intervention",
          type: input.delivery === "steer" ? "intervention.steered" : "intervention.queued",
          actor: "You",
          message: input.delivery === "steer" ? `Steered ${thread.title}` : `Queued a follow-up for ${thread.title}`,
          nodeId: thread.nodeId,
        });
      });

      if (input.delivery === "steer") {
        await this.connect();
        const current = requireThread(workflow, input.threadId);
        if (!current.codex?.threadId || !current.codex.activeTurnId) throw new BridgeConflictError("The target turn completed before it could be steered");
        try {
          await this.client.steerTurn(current.codex.threadId, input.expectedTurnId as string, message);
        } catch (error) {
          await this.failIntervention(workflowId, input.idempotencyKey, errorMessage(error));
          throw error;
        }
        return this.store.mutateWorkflow(workflowId, (draft) => {
          const target = requireThread(draft, input.threadId as string);
          target.messages.push({ id: id("user"), role: "user", content: message, timestamp: now() });
          target.lastActivityAt = now();
        });
      }

      // The original turn can complete between validation and persistence. A
      // post-persist delivery check closes that race without interrupting a
      // turn that is still active.
      await this.deliverNextQueuedIntervention(workflowId, input.threadId);
      return this.store.getWorkflow(workflowId);
    });
  }

  async respondToAttention(workflowId: string, attentionId: string, input: AttentionResponseInput): Promise<Workflow> {
    return this.withWorkflowOperation(workflowId, async () => {
      const workflow = await this.store.getWorkflow(workflowId);
      requireCurrentRun(workflow, input.runId);
      const attention = workflow.attentionRequests.find((candidate) => candidate.id === attentionId);
      if (!attention) throw new BridgeResourceNotFoundError(`Attention request ${attentionId} was not found`);
      if (attention.kind !== "user-input") throw new BridgeInputError("Only user-input attention requests accept structured answers");
      if (attention.status !== "open") throw new BridgeConflictError("This attention request is no longer open");
      const thread = attention.threadId ? requireThread(workflow, attention.threadId) : undefined;
      if (!attention.expectedTurnId || input.expectedTurnId !== attention.expectedTurnId || thread?.codex?.activeTurnId !== attention.expectedTurnId) {
        throw new BridgeConflictError("The turn that requested this input is no longer active");
      }
      const pending = this.pendingUserInputs.get(attentionId);
      if (!pending || String(pending.requestId) !== String(attention.serverRequestId)) {
        throw new BridgeConflictError("The native user-input request is no longer active");
      }
      const questions = attention.questions ?? [];
      const answers: Record<string, { answers: string[] }> = {};
      for (const question of questions) {
        const answer = input.answers[question.id];
        if (answer === undefined) throw new BridgeInputError(`Missing answer for question ${question.id}`);
        const values = (Array.isArray(answer) ? answer : [answer]).map((value) => value.trim()).filter(Boolean);
        if (!values.length) throw new BridgeInputError(`Answer for question ${question.id} cannot be empty`);
        answers[question.id] = { answers: values };
      }

      this.client.respond(pending.requestId, { answers });
      this.pendingUserInputs.delete(attentionId);
      return this.store.mutateWorkflow(workflowId, (draft) => {
        const target = draft.attentionRequests.find((candidate) => candidate.id === attentionId);
        if (!target || target.status !== "open") return;
        target.status = "resolved";
        target.resolvedAt = now();
        if (target.threadId) {
          const targetThread = requireThread(draft, target.threadId);
          targetThread.lastActivityAt = now();
          targetThread.status = "running";
          const targetNode = draft.nodes.find((node) => node.id === targetThread.nodeId);
          if (targetNode?.status === "blocked") targetNode.status = "running";
        }
        addEvent(draft, { kind: "attention", type: "attention.responded", actor: "You", message: `Answered ${questions.length} user-input question${questions.length === 1 ? "" : "s"}`, nodeId: target.nodeId });
      });
    });
  }

  private async schedule(workflowId: string): Promise<void> {
    if (this.schedulingWorkflows.has(workflowId)) {
      this.scheduleAgain.add(workflowId);
      return;
    }
    this.schedulingWorkflows.add(workflowId);
    try {
      let workflow = await this.store.getWorkflow(workflowId);
      const run = workflow.runs.at(-1);
      if (workflow.status !== "running" || run?.status !== "running") return;
      if (run.startedAt && Date.now() - new Date(run.startedAt).getTime() > workflow.budgets.maximumWallClockMinutes * 60_000) {
        await this.store.mutateWorkflow(workflowId, (draft) => failForBudget(draft, "Wall-clock budget exhausted"));
        return;
      }
      workflow = await this.store.mutateWorkflow(workflowId, propagateSkippedNodes);
      const liveRun = workflow.runs.at(-1);
      const running = workflow.nodes.filter((node) => node.status === "running").length;
      const capacity = Math.max(0, workflow.budgets.maximumConcurrentAgents - running);
      const remainingTotal = workflow.budgets.maximumTotalAgents - (liveRun?.consumedAgents ?? 0);
      if (remainingTotal <= 0 && workflow.nodes.some((node) => ["idle", "queued", "waiting"].includes(node.status))) {
        await this.store.mutateWorkflow(workflowId, (draft) => failForBudget(draft, "Total-agent budget exhausted"));
        return;
      }
      const ready = workflow.nodes.filter((node) => {
        if (!["idle", "queued", "waiting"].includes(node.status)) return false;
        const incoming = workflow.edges.filter((edge) => edge.target === node.id);
        return incoming.length === 0 || incoming.every((edge) => edge.status === "satisfied" || edge.status === "skipped");
      });
      const gates = ready.filter((node) => node.kind === "gate");
      const workers = ready.filter((node) => node.kind !== "gate").slice(0, Math.min(capacity, remainingTotal));
      await Promise.all([...gates.map((node) => this.requestGate(workflowId, node.id)), ...workers.map((node) => this.runNode(workflowId, node.id))]);
    } finally {
      this.schedulingWorkflows.delete(workflowId);
      if (this.scheduleAgain.delete(workflowId)) {
        queueMicrotask(() => void this.schedule(workflowId));
      }
    }
  }

  private async requestGate(workflowId: string, nodeId: string): Promise<void> {
    await this.store.mutateWorkflow(workflowId, (workflow) => {
      const node = requireNode(workflow, nodeId);
      if (node.kind !== "gate" || node.status === "blocked") return;
      node.status = "blocked";
      const thread = requireThread(workflow, node.threadId);
      thread.status = "waiting";
      for (const edge of workflow.edges.filter((candidate) => candidate.target === node.id)) edge.status = "waiting-approval";
      if (!workflow.attentionRequests.some((request) => request.kind === "approval-gate" && request.nodeId === node.id && request.status === "open")) {
        workflow.attentionRequests.push({
          id: id("attention"), runId: workflow.runs.at(-1)?.id ?? "manual", kind: "approval-gate", status: "open", severity: "warning",
          title: node.name, message: node.task || "Approve this gate to continue the Loop.", nodeId, threadId: thread.id, createdAt: now(),
        });
      }
      addEvent(workflow, { kind: "approval", type: "gate.requested", actor: "Codex Loop", message: `${node.name} requires explicit approval`, nodeId });
    });
  }

  async resolveGate(workflowId: string, nodeId: string, decision: "approve" | "decline"): Promise<Workflow> {
    const workflow = await this.store.mutateWorkflow(workflowId, (draft) => {
      const node = requireNode(draft, nodeId);
      const waitingEdges = draft.edges.filter((edge) => edge.target === nodeId && edge.status === "waiting-approval");
      if ((node.kind !== "gate" || node.status !== "blocked") && !waitingEdges.length) throw new BridgeConflictError("This approval gate is no longer waiting");
      const request = draft.attentionRequests.find((candidate) => candidate.kind === "approval-gate" && candidate.nodeId === nodeId && candidate.status === "open");
      if (request) { request.status = "resolved"; request.resolvedAt = now(); }
      const thread = requireThread(draft, node.threadId);
      if (decision === "approve") {
        for (const edge of waitingEdges) edge.status = "satisfied";
        if (node.kind === "gate") {
          node.status = "completed";
          node.progress = 100;
          thread.status = "completed";
          thread.finalOutput = "Approved by the user.";
          for (const edge of draft.edges.filter((candidate) => candidate.source === nodeId)) edge.status = "satisfied";
        } else {
          node.status = "queued";
          thread.status = "queued";
        }
        addEvent(draft, { kind: "approval", type: "gate.approved", actor: "You", message: `${node.name} approved`, nodeId });
      } else {
        node.status = "stopped";
        thread.status = "stopped";
        draft.status = "paused";
        const run = draft.runs.at(-1);
        if (run?.status === "running") run.status = "paused";
        addEvent(draft, { kind: "approval", type: "gate.declined", actor: "You", message: `${node.name} declined; Loop paused`, nodeId });
      }
      finishWorkflowIfDone(draft);
    });
    if (decision === "approve" && workflow.status === "running") void this.schedule(workflowId);
    return workflow;
  }

  private async runNode(workflowId: string, nodeId: string): Promise<void> {
    const launchKey = `${workflowId}:${nodeId}`;
    if (this.launchingNodes.has(launchKey)) return;
    this.launchingNodes.add(launchKey);
    try {
      const current = await this.store.getWorkflow(workflowId);
      const currentNode = requireNode(current, nodeId);
      if (currentNode.kind === "subworkflow") {
        await this.runSubworkflowNode(current, currentNode);
        return;
      }
      let workflow = await this.store.mutateWorkflow(workflowId, (draft) => {
        const node = requireNode(draft, nodeId);
        const thread = requireThread(draft, node.threadId);
        node.status = "running";
        node.progress = 8;
        node.attempt += 1;
        const run = draft.runs.at(-1);
        if (run) run.consumedAgents = (run.consumedAgents ?? 0) + 1;
        thread.status = "running";
        thread.codex = { ...thread.codex, state: "starting", lastError: undefined };
        thread.lastActivityAt = now();
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
        target.lastActivityAt = now();
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

  private async runSubworkflowNode(parent: Workflow, node: AgentNode): Promise<void> {
    const childId = node.orchestration?.subworkflowId?.trim();
    if (!childId || childId === parent.id) throw new BridgeInputError("Subworkflow nodes require a different published Loop id");
    const child = await this.store.getWorkflow(childId);
    if (child.lifecycle !== "published") throw new BridgeInputError(`Subworkflow ${child.name} must be published before it can run`);
    await this.store.mutateWorkflow(parent.id, (draft) => {
      const target = requireNode(draft, node.id);
      const thread = requireThread(draft, target.threadId);
      target.status = "running";
      target.progress = 10;
      target.attempt += 1;
      thread.status = "running";
      thread.messages.push({ id: id("system"), role: "system", content: `Started subworkflow ${child.name} (${child.id}).`, timestamp: now() });
      const run = draft.runs.at(-1);
      if (run) run.consumedAgents = (run.consumedAgents ?? 0) + 1;
      addEvent(draft, { kind: "workflow", type: "subworkflow.started", actor: target.name, message: `Started ${child.name} as a subworkflow`, nodeId: target.id });
    });
    await this.startWorkflow(child.id, { source: "manual", parentRun: { workflowId: parent.id, nodeId: node.id } });
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
    const node = workflow.nodes.find((candidate) => candidate.threadId === thread.id);
    const delegation = node?.kind === "map"
      ? `You may create bounded sub-agents for independent map items. Never exceed ${workflow.budgets.maximumConcurrentAgents} concurrent or ${workflow.budgets.maximumTotalAgents} total agents, and synthesize their evidence before returning.`
      : "Do not create sub-agents.";
    const started = await this.client.startThread({
      cwd,
      ...(model ? { model } : {}),
      approvalPolicy: workflow.approvalPolicy === "never" ? "never" : "on-request",
      sandbox: sandboxMode(),
      ephemeral: false,
      developerInstructions: `You are a worker inside a Codex Loop workflow. Complete only the assigned node task, work directly in the configured repository, verify your work, and end with a concise evidence-based result for downstream nodes. ${delegation}`,
    });
    this.nativeThreads.set(started.thread.id, { workflowId: workflow.id, threadId: thread.id });
    await this.client.setThreadName(started.thread.id, `${workflow.name} · ${thread.title}`).catch(() => undefined);
    await this.store.mutateWorkflow(workflow.id, (draft) => {
      const target = requireThread(draft, thread.id);
      target.codex = { threadId: started.thread.id, model: started.model, cwd: started.cwd, state: "idle" };
      target.lastActivityAt = now();
      addEvent(draft, { kind: "thread", type: "thread.created", actor: "Codex Loop", message: `Created native Codex thread ${started.thread.id.slice(0, 8)} for ${target.title}`, nodeId: target.nodeId });
    });
    return { threadId: started.thread.id, model: started.model, cwd: started.cwd };
  }

  private async handleNotification(notification: AppServerNotification): Promise<void> {
    const nativeId = stringValue(notification.params.threadId);
    if (!nativeId) return;
    const location = this.nativeThreads.get(nativeId);
    if (!location) return;

    if (notification.method === "thread/tokenUsage/updated") {
      await this.updateTokenUsage(nativeId, location, notification.params);
      return;
    }

    if (notification.method === "serverRequest/resolved") {
      await this.resolveServerRequest(location, notification.params.requestId);
      return;
    }

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
        thread.lastActivityAt = now();
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
        thread.lastActivityAt = now();
      });
      return;
    }
    if (/delta|progress|terminalInteraction|patchUpdated/i.test(notification.method)) {
      await this.touchThread(location);
    }
  }

  private async handleRequest(request: AppServerRequest): Promise<void> {
    const nativeId = stringValue(request.params.threadId);
    const location = nativeId ? this.nativeThreads.get(nativeId) : undefined;
    if (location && request.method === "item/tool/requestUserInput") {
      const questions = parseAttentionQuestions(request.params.questions);
      const attentionId = id("attention");
      this.pendingUserInputs.set(attentionId, { requestId: request.id, workflowId: location.workflowId, attentionId });
      await this.store.mutateWorkflow(location.workflowId, (workflow) => {
        const thread = requireThread(workflow, location.threadId);
        const turnId = stringValue(request.params.turnId) || thread.codex?.activeTurnId;
        thread.lastActivityAt = now();
        thread.status = "waiting";
        const node = workflow.nodes.find((candidate) => candidate.id === thread.nodeId);
        if (node?.status === "running") node.status = "blocked";
        workflow.attentionRequests.push({
          id: attentionId,
          runId: workflow.runs.at(-1)?.id ?? "manual",
          kind: "user-input",
          status: "open",
          severity: "warning",
          title: questions[0]?.header || "Codex needs your input",
          message: questions.map((question) => question.question).join(" ") || `${thread.title} requested user input`,
          threadId: thread.id,
          nodeId: thread.nodeId,
          expectedTurnId: turnId,
          serverRequestId: request.id,
          questions,
          autoResolutionMs: numberOrNull(request.params.autoResolutionMs),
          createdAt: now(),
        });
        addEvent(workflow, { kind: "attention", type: "attention.user-input-requested", actor: thread.title, message: `${thread.title} requested user input`, nodeId: thread.nodeId });
      });
      return;
    }
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
      thread.lastActivityAt = now();
      addEvent(workflow, { kind: "approval", type: "approval.requested", actor: thread.title, message: `${thread.title} requested ${type} approval`, nodeId: thread.nodeId });
    });
  }

  private async updateAssistantDelta(location: ThreadLocation, itemId: string, delta: string): Promise<void> {
    if (!itemId || !delta) return;
    await this.store.mutateWorkflow(location.workflowId, (workflow) => {
      const thread = requireThread(workflow, location.threadId);
      thread.lastActivityAt = now();
      const existing = thread.messages.find((message) => message.id === itemId);
      if (existing) existing.content += delta;
      else thread.messages.push({ id: itemId, role: "assistant", content: delta, timestamp: now() });
      const node = workflow.nodes.find((candidate) => candidate.id === thread.nodeId);
      if (node) node.progress = Math.min(90, Math.max(node.progress, 35));
    });
  }

  private async updateTokenUsage(nativeThreadId: string, location: ThreadLocation, params: Record<string, unknown>): Promise<void> {
    const tokenUsage = asRecord(params.tokenUsage);
    const total = numericValue(asRecord(tokenUsage.total).totalTokens);
    const last = numericValue(asRecord(tokenUsage.last).totalTokens);
    if (total === undefined) return;
    const previous = this.tokenUsageTotals.get(nativeThreadId);
    this.tokenUsageTotals.set(nativeThreadId, total);
    const delta = previous === undefined ? Math.max(0, last ?? 0) : Math.max(0, total - previous);
    if (delta === 0) return;
    let exhausted = false;
    const updated = await this.store.mutateWorkflow(location.workflowId, (workflow) => {
      const run = workflow.runs.at(-1);
      if (workflow.status !== "running" || run?.status !== "running") return;
      run.consumedTokens = (run.consumedTokens ?? 0) + delta;
      if (workflow.budgets.maximumTokens && run.consumedTokens >= workflow.budgets.maximumTokens) {
        exhausted = true;
        failForBudget(workflow, `Token budget exhausted at ${run.consumedTokens.toLocaleString()} tokens`);
      }
    });
    if (!exhausted) return;
    await Promise.allSettled(updated.threads.flatMap((thread) => thread.codex?.activeTurnId && thread.codex.threadId
      ? [this.client.interruptTurn(thread.codex.threadId, thread.codex.activeTurnId)]
      : []));
  }

  private async updateItem(location: ThreadLocation, item: Record<string, unknown>, completed: boolean): Promise<void> {
    const itemType = stringValue(item.type);
    const itemId = stringValue(item.id);
    if (!itemId) return;
    await this.store.mutateWorkflow(location.workflowId, (workflow) => {
      const thread = requireThread(workflow, location.threadId);
      thread.lastActivityAt = now();
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
      const queuedFollowUp = status === "completed" && draft.interventions.some((record) => record.delivery === "queue" && record.status === "pending" && record.threadId === thread.id);
      thread.codex = { ...thread.codex, activeTurnId: undefined, state: status === "completed" ? "idle" : status === "interrupted" ? "stopped" : "failed", lastError: error || undefined };
      thread.lastActivityAt = now();
      const activeRun = draft.runs.at(-1);
      if (draft.status === "failed" || activeRun?.status === "stopped") {
        thread.status = "stopped";
        if (node && !["completed", "skipped", "failed"].includes(node.status)) node.status = "stopped";
        if (attempt?.status === "running") {
          attempt.status = "stopped";
          attempt.summary = "Stopped by the Loop supervisor";
        }
        return;
      }
      if (status === "completed") {
        thread.status = queuedFollowUp ? "queued" : "completed";
        if (attempt?.status === "running") {
          attempt.status = "completed";
          attempt.summary = "Native Codex turn completed";
        }
        if (node && queuedFollowUp) {
          node.status = "running";
          node.progress = Math.max(node.progress, 90);
          addEvent(draft, { kind: "intervention", type: "intervention.follow-up-ready", actor: "Codex Loop", message: `Starting the queued follow-up for ${thread.title}`, nodeId: node.id });
        } else if (node) {
          node.status = "completed";
          node.progress = 100;
          const outgoing = draft.edges.filter((candidate) => candidate.source === node.id);
          const targetIds = outgoing.map((edge) => edge.target);
          const selectedRoutes = node.kind === "condition" ? parseSelectedRoutes(thread.finalOutput ?? "", draft, outgoing) : new Set(outgoing.map((edge) => edge.target));
          const shouldContinueLoop = node.kind === "loop" && /\bLOOP_STATUS\s*:\s*continue\b/i.test(thread.finalOutput ?? "");
          const run = draft.runs.at(-1);
          if (shouldContinueLoop && run && (run.consumedIterations ?? 0) < Math.min(node.orchestration?.maximumIterations ?? draft.budgets.maximumIterations, draft.budgets.maximumIterations)) {
            const fingerprint = createHash("sha256").update(thread.finalOutput ?? "").digest("hex");
            run.noProgressRounds = run.lastProgressFingerprint === fingerprint ? (run.noProgressRounds ?? 0) + 1 : 0;
            run.lastProgressFingerprint = fingerprint;
            if ((run.noProgressRounds ?? 0) >= draft.budgets.maximumNoProgressRounds) {
              node.status = "stopped";
              thread.status = "stopped";
              failForBudget(draft, `No progress after ${run.noProgressRounds} repeated loop round${run.noProgressRounds === 1 ? "" : "s"}`);
              return;
            }
            run.consumedIterations = (run.consumedIterations ?? 0) + 1;
            node.status = "queued";
            node.progress = 0;
            thread.status = "queued";
            for (const edge of outgoing) edge.status = "idle";
            addEvent(draft, { kind: "workflow", type: "loop.iteration", actor: node.name, message: `${node.name} requested another bounded iteration`, nodeId: node.id });
            return;
          }
          for (const edge of outgoing) {
            edge.status = selectedRoutes.has(edge.target) ? edge.approvalRequired || edge.trigger === "manual-approval" ? "waiting-approval" : "satisfied" : "skipped";
            if (edge.status === "waiting-approval") {
              const target = draft.nodes.find((candidate) => candidate.id === edge.target);
              if (target && !draft.attentionRequests.some((request) => request.kind === "approval-gate" && request.nodeId === target.id && request.status === "open")) {
                target.status = "blocked";
                draft.attentionRequests.push({ id: id("attention"), runId: run?.id ?? "manual", kind: "approval-gate", status: "open", severity: "warning", title: `Approve handoff to ${target.name}`, message: `Review ${node.name}'s result before ${target.name} starts.`, nodeId: target.id, threadId: target.threadId, createdAt: now() });
              }
            }
          }
          if (targetIds.length) {
            const block = resultContext(draft, node, thread, targetIds);
            if (!draft.contextBlocks.some((candidate) => candidate.id === block.id)) draft.contextBlocks.push(block);
            for (const target of draft.nodes.filter((candidate) => targetIds.includes(candidate.id))) {
              if (!target.readableContextBlockIds.includes(block.id)) target.readableContextBlockIds.push(block.id);
            }
          }
          addEvent(draft, { kind: "agent", type: "node.completed", actor: node.name, message: `${node.name} completed in native Codex`, nodeId: node.id });
          if (run) {
            const checkpoint = {
              id: id("checkpoint"), nodeId: node.id, cacheKey: checkpointCacheKey(draft, node, run), status: "completed" as const,
              outputSummary: (thread.finalOutput || `${node.name} completed successfully.`).slice(0, 2_000), createdAt: now(),
            };
            run.checkpoints = [...(run.checkpoints ?? []).filter((candidate) => candidate.nodeId !== node.id), checkpoint];
          }
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
            failPendingInterventions(draft, "Workflow failed before queued guidance could be delivered");
            addRetryExhaustedAttention(draft, node, thread);
          }
          if (!retry && status === "interrupted") failPendingThreadInterventions(draft, thread.id, "Target turn was interrupted before queued guidance could be delivered");
        }
        addEvent(draft, { kind: "agent", type: `node.${status || "failed"}`, actor: node?.name ?? thread.title, message: error || `Codex turn ${status || "failed"}`, nodeId: node?.id });
      }
      finishWorkflowIfDone(draft);
    });
    if (status === "completed") await this.deliverQueuedInterventions(workflow.id, location.threadId);
    const current = await this.store.getWorkflow(workflow.id);
    const parentRun = current.runs.at(-1)?.parentRun;
    if (parentRun && ["completed", "failed", "stopped"].includes(current.status)) await this.completeSubworkflowParent(current, parentRun);
    if (current.status === "running") void this.schedule(workflow.id);
  }

  private async completeSubworkflowParent(child: Workflow, parent: { workflowId: string; nodeId: string }): Promise<void> {
    const completed = child.status === "completed";
    const workflow = await this.store.mutateWorkflow(parent.workflowId, (draft) => {
      const node = requireNode(draft, parent.nodeId);
      if (node.kind !== "subworkflow" || node.status !== "running") return;
      const thread = requireThread(draft, node.threadId);
      if (completed) {
        node.status = "completed";
        node.progress = 100;
        thread.status = "completed";
        thread.finalOutput = `Subworkflow ${child.name} completed at revision ${child.revision}.`;
        for (const edge of draft.edges.filter((candidate) => candidate.source === node.id)) edge.status = "satisfied";
        const run = draft.runs.at(-1);
        if (run) run.checkpoints = [...(run.checkpoints ?? []), { id: id("checkpoint"), nodeId: node.id, cacheKey: checkpointCacheKey(draft, node, run), status: "completed", outputSummary: thread.finalOutput, createdAt: now() }];
        addEvent(draft, { kind: "workflow", type: "subworkflow.completed", actor: node.name, message: `${child.name} completed`, nodeId: node.id });
        finishWorkflowIfDone(draft);
      } else {
        node.status = "failed";
        thread.status = "failed";
        draft.status = "failed";
        const run = draft.runs.at(-1);
        if (run?.status === "running") run.status = "stopped";
        addEvent(draft, { kind: "workflow", type: "subworkflow.failed", actor: node.name, message: `${child.name} ended with ${child.status}`, nodeId: node.id });
      }
    });
    if (workflow.status === "running") void this.schedule(parent.workflowId);
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
        addRetryExhaustedAttention(workflow, node, thread);
      }
      addEvent(workflow, { kind: "agent", type: retry ? "node.retrying" : "node.failed", actor: node.name, message: retry ? `${message}; retrying` : message, nodeId });
    });
    return retry;
  }

  private async deliverQueuedInterventions(workflowId: string, threadId: string): Promise<void> {
    await this.withWorkflowOperation(workflowId, () => this.deliverNextQueuedIntervention(workflowId, threadId));
  }

  private async deliverPendingInterventions(workflowId: string): Promise<void> {
    await this.withWorkflowOperation(workflowId, async () => {
      const workflow = await this.store.getWorkflow(workflowId);
      const threadIds = Array.from(new Set(workflow.interventions
        .filter((record) => record.delivery === "queue" && record.status === "pending" && record.threadId)
        .map((record) => record.threadId as string)));
      for (const threadId of threadIds) await this.deliverNextQueuedIntervention(workflowId, threadId);
    });
  }

  private async deliverNextQueuedIntervention(workflowId: string, threadId: string): Promise<void> {
    let workflow = await this.store.getWorkflow(workflowId);
    if (workflow.status !== "running" || workflow.runs.at(-1)?.status !== "running") return;
    const record = workflow.interventions.find((candidate) => candidate.delivery === "queue" && candidate.status === "pending" && candidate.threadId === threadId);
    if (!record) return;
    const thread = requireThread(workflow, threadId);
    if (thread.codex?.activeTurnId) return;
    await this.connect();
    const native = await this.ensureThread(workflow, thread);
    workflow = await this.store.getWorkflow(workflowId);
    if (workflow.status !== "running" || workflow.runs.at(-1)?.id !== record.runId || workflow.runs.at(-1)?.status !== "running") return;
    const currentRecord = workflow.interventions.find((candidate) => candidate.id === record.id);
    if (!currentRecord || currentRecord.status !== "pending") return;
    const currentThread = requireThread(workflow, threadId);
    if (currentThread.codex?.activeTurnId) return;
    try {
      const turn = await this.client.startTurn({
        threadId: native.threadId,
        input: [textInput(record.message)],
        effort: effortFor(workflow.nodes.find((node) => node.id === currentThread.nodeId)),
        responsesapiClientMetadata: { codex_loop_workflow_id: workflow.id, codex_loop_intervention_id: record.id },
      });
      await this.store.mutateWorkflow(workflowId, (draft) => {
        const targetRecord = draft.interventions.find((candidate) => candidate.id === record.id);
        if (!targetRecord || targetRecord.status !== "pending") return;
        const target = requireThread(draft, threadId);
        const node = draft.nodes.find((candidate) => candidate.id === target.nodeId);
        targetRecord.status = "delivered";
        targetRecord.deliveredAt = now();
        target.messages.push({ id: id("user"), role: "user", content: record.message, timestamp: now() });
        target.status = "running";
        target.lastActivityAt = now();
        target.codex = { ...target.codex, threadId: native.threadId, activeTurnId: turn.turn.id, state: "running" };
        target.attempts.push({ number: target.attempts.length + 1, model: node?.effectiveModel ?? target.model, status: "running", receivedContextBlockIds: node?.readableContextBlockIds ?? [], summary: "Queued user intervention in progress" });
        if (node) node.status = "running";
        addEvent(draft, { kind: "intervention", type: "intervention.queue-delivered", actor: "Codex Loop", message: `Delivered queued follow-up to ${target.title}`, nodeId: target.nodeId });
      });
    } catch (error) {
      await this.failIntervention(workflowId, record.idempotencyKey, errorMessage(error));
      throw error;
    }
  }

  private async failIntervention(workflowId: string, idempotencyKey: string, message: string): Promise<void> {
    await this.store.mutateWorkflow(workflowId, (workflow) => {
      const record = workflow.interventions.find((candidate) => candidate.idempotencyKey === idempotencyKey);
      if (!record) return;
      record.status = "failed";
      record.error = message;
      addEvent(workflow, { kind: "intervention", type: "intervention.failed", actor: "Codex Loop", message: `Intervention delivery failed: ${message}`, nodeId: record.threadId ? workflow.threads.find((thread) => thread.id === record.threadId)?.nodeId : undefined });
    });
  }

  private async touchThread(location: ThreadLocation): Promise<void> {
    await this.store.mutateWorkflow(location.workflowId, (workflow) => {
      requireThread(workflow, location.threadId).lastActivityAt = now();
    });
  }

  private async resolveServerRequest(location: ThreadLocation, requestId: unknown): Promise<void> {
    const requestKey = String(requestId ?? "");
    if (!requestKey) return;
    const workflow = await this.store.mutateWorkflow(location.workflowId, (draft) => {
      const attention = draft.attentionRequests.find((candidate) => candidate.status === "open" && String(candidate.serverRequestId) === requestKey);
      if (!attention) return;
      attention.status = "resolved";
      attention.resolvedAt = now();
      const thread = requireThread(draft, location.threadId);
      thread.lastActivityAt = now();
      thread.status = "running";
      const node = draft.nodes.find((candidate) => candidate.id === thread.nodeId);
      if (node?.status === "blocked") node.status = "running";
      addEvent(draft, { kind: "attention", type: "attention.auto-resolved", actor: "Codex", message: `User-input request for ${thread.title} was resolved by Codex`, nodeId: thread.nodeId });
    });
    this.pendingUserInputs.forEach((pending, attentionId) => {
      if (pending.workflowId === workflow.id && String(pending.requestId) === requestKey) this.pendingUserInputs.delete(attentionId);
    });
  }

  private async expireStaleInputRequests(): Promise<void> {
    const { workflows } = await this.store.getData();
    for (const workflow of workflows) {
      if (!workflow.attentionRequests.some((attention) => attention.kind === "user-input" && attention.status === "open")) continue;
      await this.store.mutateWorkflow(workflow.id, (draft) => {
        let failedWaitingThread = false;
        for (const attention of draft.attentionRequests) {
          if (attention.kind !== "user-input" || attention.status !== "open") continue;
          attention.status = "expired";
          attention.resolvedAt = now();
          const thread = attention.threadId ? draft.threads.find((candidate) => candidate.id === attention.threadId) : undefined;
          if (thread?.codex?.activeTurnId) {
            failedWaitingThread = true;
            thread.status = "failed";
            thread.codex = { ...thread.codex, activeTurnId: undefined, state: "failed", lastError: "The native input request expired with the previous app-server process" };
            const node = draft.nodes.find((candidate) => candidate.id === thread.nodeId);
            if (node) node.status = "failed";
          }
          addEvent(draft, { kind: "attention", type: "attention.expired", actor: "Codex Loop", message: "A user-input request expired after the Codex app-server restarted", nodeId: attention.nodeId });
        }
        if (failedWaitingThread && ["running", "paused"].includes(draft.status)) {
          draft.status = "failed";
          const run = draft.runs.at(-1);
          if (run && ["running", "paused"].includes(run.status)) run.status = "stopped";
          failPendingInterventions(draft, "Native input expired before queued guidance could be delivered");
        }
      });
    }
  }

  private async handleAppServerExit(error: Error): Promise<void> {
    this.bridgeStatus = { state: "disconnected", error: error.message };
    this.pendingUserInputs.clear();
    this.pendingApprovals.clear();
    await this.expireStaleInputRequests();
    const { workflows } = await this.store.getData();
    for (const workflow of workflows.filter((candidate) => candidate.threads.some((thread) => thread.codex?.activeTurnId))) {
      await this.store.mutateWorkflow(workflow.id, (draft) => {
        for (const thread of draft.threads.filter((candidate) => candidate.codex?.activeTurnId)) {
          thread.status = "failed";
          thread.codex = { ...thread.codex, activeTurnId: undefined, state: "failed", lastError: error.message };
          const node = draft.nodes.find((candidate) => candidate.id === thread.nodeId);
          if (node) node.status = "failed";
        }
        if (["running", "paused"].includes(draft.status)) {
          draft.status = "failed";
          const run = draft.runs.at(-1);
          if (run && ["running", "paused"].includes(run.status)) run.status = "stopped";
        }
        failPendingInterventions(draft, "Codex app-server disconnected before delivery");
        addEvent(draft, { kind: "workflow", type: "workflow.bridge-disconnected", actor: "Codex Loop", message: "Codex app-server disconnected while work was active" });
      });
    }
    this.nativeThreads.clear();
  }

  private withWorkflowOperation<T>(workflowId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueues.get(workflowId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    this.operationQueues.set(workflowId, pending);
    void pending.then(
      () => { if (this.operationQueues.get(workflowId) === pending) this.operationQueues.delete(workflowId); },
      () => { if (this.operationQueues.get(workflowId) === pending) this.operationQueues.delete(workflowId); },
    );
    return pending;
  }
}

function scrubbedCapabilityProbeEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "GH_HOST", "GH_CONFIG_DIR", "XDG_CONFIG_HOME", "HOME"];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}

async function currentRepositoryRevision(): Promise<string> {
  try {
    const cwd = path.resolve(process.env.CODEX_LOOP_WORKSPACE ?? process.cwd());
    const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd, timeout: 5_000, env: scrubbedCapabilityProbeEnvironment() });
    return result.stdout.trim() || "workspace-current";
  } catch {
    return "workspace-current";
  }
}

function checkpointCacheKey(workflow: Workflow, node: AgentNode, run: Workflow["runs"][number]): string {
  const input = JSON.stringify({
    workflowRevision: run.workflowRevision ?? workflow.revision,
    repositoryRevision: run.repositoryRevision ?? "workspace-current",
    input: run.input ?? {},
    node: {
      id: node.id, kind: node.kind, task: node.task, definitionOfDone: node.definitionOfDone,
      model: node.configuredModel, effort: node.reasoningEffort, connectors: node.connectors, orchestration: node.orchestration,
    },
  });
  return createHash("sha256").update(input).digest("hex");
}

function propagateSkippedNodes(workflow: Workflow): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of workflow.nodes) {
      if (!["idle", "queued", "waiting"].includes(node.status)) continue;
      const incoming = workflow.edges.filter((edge) => edge.target === node.id);
      if (!incoming.length || !incoming.every((edge) => edge.status === "skipped")) continue;
      node.status = "skipped";
      node.progress = 100;
      for (const edge of workflow.edges.filter((candidate) => candidate.source === node.id)) edge.status = "skipped";
      const thread = workflow.threads.find((candidate) => candidate.nodeId === node.id);
      if (thread) thread.status = "skipped";
      addEvent(workflow, { kind: "agent", type: "node.skipped", actor: "Codex Loop", message: `${node.name} was skipped by workflow routing`, nodeId: node.id });
      changed = true;
    }
  }
  finishWorkflowIfDone(workflow);
}

function parseSelectedRoutes(output: string, workflow: Workflow, outgoing: Workflow["edges"]): Set<string> {
  const match = output.match(/\bROUTE\s*:\s*([^\n]+)/i);
  if (!match) return new Set(outgoing.map((edge) => edge.target));
  const requested = match[1].split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  return new Set(outgoing.flatMap((edge) => {
    const target = workflow.nodes.find((node) => node.id === edge.target);
    return requested.includes(edge.target.toLowerCase()) || (target && requested.includes(target.name.toLowerCase())) ? [edge.target] : [];
  }));
}

function failForBudget(workflow: Workflow, reason: string): void {
  workflow.status = "failed";
  const run = workflow.runs.at(-1);
  if (run?.status === "running") run.status = "stopped";
  for (const node of workflow.nodes) if (!["completed", "skipped", "failed", "stopped"].includes(node.status)) node.status = "stopped";
  for (const thread of workflow.threads) if (!["completed", "skipped", "failed", "stopped"].includes(thread.status)) thread.status = "stopped";
  addEvent(workflow, { kind: "workflow", type: "workflow.budget-exhausted", actor: "Loop supervisor", message: reason });
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
    `Run budgets: ${workflow.budgets.maximumConcurrentAgents} concurrent agents, ${workflow.budgets.maximumTotalAgents} total agents, ${workflow.budgets.maximumIterations} iterations, ${workflow.budgets.maximumWallClockMinutes} minutes, ${workflow.budgets.maximumNoProgressRounds} no-progress rounds${workflow.budgets.maximumTokens ? `, ${workflow.budgets.maximumTokens} tokens` : ""}.`,
    `Orchestration kind: ${node.kind}`,
    node.kind === "map" ? `Map over: ${node.orchestration?.collectionExpression ?? "the collection discovered by this task"}. Use isolated subagents for independent items when available and stay within the Loop budgets.` : "",
    node.kind === "condition" ? "End with `ROUTE: <target node name or id>, ...` to select outgoing branches. Select only branches supported by evidence." : "",
    node.kind === "loop" ? `Stop condition: ${node.orchestration?.stopCondition ?? node.definitionOfDone}. End with exactly \`LOOP_STATUS: done\` or \`LOOP_STATUS: continue\`.` : "",
    node.kind === "verify" ? `Verification rubric: ${node.orchestration?.verificationRubric ?? node.definitionOfDone}. Independently challenge upstream claims.` : "",
    runInput,
    "Shared context explicitly granted to you:",
    context,
    "Complete this task in the current repository. Use tools as needed, verify the result, and finish with a concise handoff summary for downstream nodes.",
  ].filter(Boolean).join("\n\n");
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
  if (!workflow.nodes.length || !workflow.nodes.every((node) => node.status === "completed" || node.status === "skipped")) return;
  workflow.status = "completed";
  const run = workflow.runs.at(-1);
  if (run) {
    run.status = "completed";
    run.completedAt = now();
  }
  addEvent(workflow, { kind: "workflow", type: "workflow.completed", actor: "Codex Loop", message: `Workflow completed through ${workflow.nodes.length} native Codex threads` });
}

function requireCurrentRun(workflow: Workflow, runId: string, requireActive = true): void {
  const run = workflow.runs.at(-1);
  if (!run || run.id !== runId) throw new BridgeConflictError("The workflow run changed; refresh before intervening");
  if (requireActive && !["running", "paused"].includes(run.status)) throw new BridgeConflictError("The target workflow run is no longer active");
  if (!requireActive && run.status === "completed") throw new BridgeConflictError("The target workflow run is already complete");
}

function parseAttentionQuestions(value: unknown): AttentionQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const question = asRecord(entry);
    const questionId = stringValue(question.id);
    const prompt = stringValue(question.question);
    if (!questionId || !prompt) return [];
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
        const candidate = asRecord(option);
        const label = stringValue(candidate.label);
        return label ? [{ label, description: stringValue(candidate.description) }] : [];
      })
      : null;
    return [{
      id: questionId,
      header: stringValue(question.header) || "Input required",
      question: prompt,
      isOther: question.isOther === true,
      isSecret: question.isSecret === true,
      options,
    }];
  });
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numericValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function contextPosition(workflow: Workflow, recipientNodeIds: string[]): { x: number; y: number } {
  const nodes = workflow.nodes.filter((node) => recipientNodeIds.includes(node.id));
  if (!nodes.length) return { x: 80, y: 560 };
  return {
    x: Math.round(nodes.reduce((sum, node) => sum + node.position.x, 0) / nodes.length),
    y: Math.max(...nodes.map((node) => node.position.y + node.size.height)) + 80,
  };
}

function expireOpenAttention(workflow: Workflow, reason: string): void {
  let expired = false;
  for (const attention of workflow.attentionRequests.filter((candidate) => candidate.status === "open")) {
    attention.status = "expired";
    attention.resolvedAt = now();
    expired = true;
  }
  for (const thread of workflow.threads) thread.pendingApproval = undefined;
  if (expired) {
    addEvent(workflow, { kind: "attention", type: "attention.expired", actor: "Codex Loop", message: reason });
  }
}

function failPendingInterventions(workflow: Workflow, reason: string): void {
  for (const intervention of workflow.interventions.filter((candidate) => candidate.status === "pending")) {
    intervention.status = "failed";
    intervention.error = reason;
  }
}

function failPendingThreadInterventions(workflow: Workflow, threadId: string, reason: string): void {
  for (const intervention of workflow.interventions.filter((candidate) => candidate.status === "pending" && candidate.threadId === threadId)) {
    intervention.status = "failed";
    intervention.error = reason;
  }
}

function addRetryExhaustedAttention(workflow: Workflow, node: AgentNode, thread: ThreadRecord): void {
  if (node.attempt < node.retryPolicy.maxAttempts) return;
  const asksUser = workflow.edges.some((edge) => edge.source === node.id && edge.failureBehavior === "ask-user")
    || workflow.observers.some((observer) => observer.coveredNodeIds.includes(node.id) && observer.escalationBehavior === "ask-user");
  const run = workflow.runs.at(-1);
  if (!asksUser || !run || workflow.attentionRequests.some((attention) => attention.runId === run.id && attention.kind === "retry-exhausted" && attention.nodeId === node.id && attention.status === "open")) return;
  workflow.attentionRequests.push({
    id: id("attention"),
    runId: run.id,
    kind: "retry-exhausted",
    status: "open",
    severity: "critical",
    title: `${node.name} exhausted its retries`,
    message: "The loop needs user direction before the next recovery attempt.",
    nodeId: node.id,
    threadId: thread.id,
    createdAt: now(),
  });
  addEvent(workflow, { kind: "attention", type: "attention.retry-exhausted", actor: "Loop supervisor", message: `${node.name} exhausted its retries and needs user direction`, nodeId: node.id });
}

function sameInterventionPayload(record: Workflow["interventions"][number], input: InterventionInput, message: string): boolean {
  const recordRecipients = [...(record.recipientNodeIds ?? [])].sort();
  const inputRecipients = [...(input.recipientNodeIds ?? [])].sort();
  return record.runId === input.runId
    && record.delivery === input.delivery
    && record.message === message
    && record.threadId === input.threadId
    && record.expectedTurnId === input.expectedTurnId
    && JSON.stringify(recordRecipients) === JSON.stringify(inputRecipients);
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
