import type { AttentionKind, AuditEvent, Workflow } from "../src/domain/types.js";
import { JsonWorkflowStore } from "./store.js";

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_STALL_THRESHOLD_MS = 120_000;

export interface AttentionSupervisorOptions {
  intervalMs?: number;
  stallThresholdMs?: number;
  now?: () => Date;
}

export class AttentionSupervisor {
  private timer?: ReturnType<typeof setInterval>;
  private readonly intervalMs: number;
  private readonly stallThresholdMs: number;
  private readonly currentTime: () => Date;

  constructor(private readonly store: JsonWorkflowStore, options: AttentionSupervisorOptions = {}) {
    this.intervalMs = options.intervalMs ?? positiveNumber(process.env.CODEX_LOOP_SUPERVISOR_INTERVAL_MS, DEFAULT_INTERVAL_MS);
    this.stallThresholdMs = options.stallThresholdMs ?? positiveNumber(process.env.CODEX_LOOP_STALL_THRESHOLD_MS, DEFAULT_STALL_THRESHOLD_MS);
    this.currentTime = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer) return;
    void this.scan();
    this.timer = setInterval(() => { void this.scan(); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async scan(): Promise<void> {
    const { workflows } = await this.store.getData();
    for (const workflow of workflows) await this.scanWorkflow(workflow);
  }

  private async scanWorkflow(snapshot: Workflow): Promise<void> {
    const run = snapshot.runs.at(-1);
    if (!run) return;
    const candidates: Array<{ kind: AttentionKind; title: string; message: string; severity: "warning" | "critical"; threadId?: string; nodeId?: string; expectedTurnId?: string }> = [];
    const currentMs = this.currentTime().getTime();

    if (snapshot.status === "running" && run.status === "running") {
      for (const thread of snapshot.threads.filter((candidate) => candidate.codex?.activeTurnId)) {
        const waitingForUser = Boolean(thread.pendingApproval)
          || snapshot.attentionRequests.some((attention) => attention.runId === run.id
            && attention.kind === "user-input"
            && attention.status === "open"
            && attention.threadId === thread.id);
        if (waitingForUser) continue;
        const lastActivityMs = Date.parse(thread.lastActivityAt ?? run.startedAt ?? "");
        if (Number.isFinite(lastActivityMs) && currentMs - lastActivityMs >= this.stallThresholdMs) {
          candidates.push({
            kind: "suspected-stall",
            title: `${thread.title} may be stalled`,
            message: `No meaningful Codex activity has been observed for at least ${Math.ceil(this.stallThresholdMs / 1_000)} seconds.`,
            severity: "warning",
            threadId: thread.id,
            nodeId: thread.nodeId,
            expectedTurnId: thread.codex?.activeTurnId,
          });
        }
      }

      const hasActiveWork = snapshot.threads.some((thread) => thread.codex?.activeTurnId || ["starting", "running"].includes(thread.codex?.state ?? ""));
      const hasLaunchableNode = snapshot.nodes.some((node) => {
        if (!["idle", "queued", "waiting"].includes(node.status)) return false;
        return snapshot.edges.filter((edge) => edge.target === node.id).every((edge) => snapshot.nodes.find((source) => source.id === edge.source)?.status === "completed");
      });
      const hasOpenInput = snapshot.attentionRequests.some((attention) => attention.runId === run.id && attention.kind === "user-input" && attention.status === "open");
      const incomplete = snapshot.nodes.some((node) => node.status !== "completed");
      if (incomplete && !hasActiveWork && !hasLaunchableNode && !hasOpenInput) {
        candidates.push({ kind: "deadlock", title: "Workflow cannot make progress", message: "No Codex turn is active and no incomplete node is eligible to start.", severity: "critical" });
      }
    }

    for (const node of snapshot.nodes.filter((candidate) => candidate.status === "failed" && candidate.attempt >= candidate.retryPolicy.maxAttempts)) {
      const asksUser = snapshot.edges.some((edge) => edge.source === node.id && edge.failureBehavior === "ask-user")
        || snapshot.observers.some((observer) => observer.coveredNodeIds.includes(node.id) && observer.escalationBehavior === "ask-user");
      if (asksUser) candidates.push({ kind: "retry-exhausted", title: `${node.name} exhausted its retries`, message: "The loop needs user direction before it can recover from this failure.", severity: "critical", nodeId: node.id, threadId: node.threadId });
    }

    const hasRecoveredAttention = snapshot.attentionRequests.some((attention) => {
      if (attention.runId !== run.id || attention.status !== "open" || !["suspected-stall", "deadlock"].includes(attention.kind)) return false;
      return !candidates.some((candidate) => candidate.kind === attention.kind
        && candidate.threadId === attention.threadId
        && candidate.nodeId === attention.nodeId
        && candidate.expectedTurnId === attention.expectedTurnId);
    });
    if (!candidates.length && !hasRecoveredAttention) return;
    await this.store.mutateWorkflow(snapshot.id, (workflow) => {
      if (workflow.updatedAt !== snapshot.updatedAt) return;
      for (const attention of workflow.attentionRequests) {
        if (attention.runId !== run.id || attention.status !== "open" || !["suspected-stall", "deadlock"].includes(attention.kind)) continue;
        const stillActive = candidates.some((candidate) => candidate.kind === attention.kind
          && candidate.threadId === attention.threadId
          && candidate.nodeId === attention.nodeId
          && candidate.expectedTurnId === attention.expectedTurnId);
        if (stillActive) continue;
        const resolvedAt = this.currentTime().toISOString();
        attention.status = "resolved";
        attention.resolvedAt = resolvedAt;
        addSupervisorEvent(workflow, attention.kind, `${attention.title} recovered without user action.`, attention.nodeId, resolvedAt, `attention.${attention.kind}-resolved`);
      }
      for (const candidate of candidates) {
        const duplicate = workflow.attentionRequests.some((attention) => attention.runId === run.id && attention.kind === candidate.kind && attention.status === "open" && attention.threadId === candidate.threadId && attention.nodeId === candidate.nodeId);
        if (duplicate) continue;
        const createdAt = this.currentTime().toISOString();
        workflow.attentionRequests.push({ id: `attention-${globalThis.crypto.randomUUID()}`, runId: run.id, status: "open", createdAt, ...candidate });
        addSupervisorEvent(workflow, candidate.kind, candidate.message, candidate.nodeId, createdAt);
      }
    });
  }
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function addSupervisorEvent(workflow: Workflow, kind: AttentionKind, message: string, nodeId: string | undefined, timestamp: string, type = `attention.${kind}`): void {
  const run = workflow.runs.at(-1);
  if (run) run.step += 1;
  const event: AuditEvent = {
    id: `event-${globalThis.crypto.randomUUID()}`,
    sequence: workflow.events.length + 1,
    runId: run?.id ?? "manual",
    kind: "attention",
    type,
    actor: "Loop supervisor",
    message,
    timestamp,
    logicalTime: run?.step ?? 0,
    nodeId,
  };
  workflow.events.push(event);
}
