import { normalizeAgentModel, normalizeReasoningEffort } from "./models";
import type { AgentNode, EnvironmentVariable, ObserverRegion, Rect, Workflow, WorkflowRunConfiguration } from "./types";

export const COMPACT_AGENT_SIZE = { width: 100, height: 108 } as const;
const LEGACY_MODEL_PATTERN = /gpt-[\w.-]+/gi;

export function supervisorBounds(nodes: AgentNode[]): Rect {
  if (nodes.length === 0) return { x: 100, y: 80, width: 560, height: 340 };
  const left = Math.min(...nodes.map((node) => node.position.x));
  const top = Math.min(...nodes.map((node) => node.position.y));
  const right = Math.max(...nodes.map((node) => node.position.x + COMPACT_AGENT_SIZE.width));
  const bottom = Math.max(...nodes.map((node) => node.position.y + COMPACT_AGENT_SIZE.height));
  return {
    x: left - 74,
    y: top - 68,
    width: right - left + 148,
    height: bottom - top + 136,
  };
}

export function createLoopSupervisor(nodes: AgentNode[], source?: ObserverRegion): ObserverRegion {
  return {
    id: source?.id ?? "loop-supervisor",
    name: "Loop supervisor",
    instructions: "Track loop health, detect stalled or failed work, and coordinate recovery without taking over agent tasks.",
    bounds: supervisorBounds(nodes),
    coveredNodeIds: nodes.map((node) => node.id),
    conditions: source?.conditions?.length ? source.conditions : ["stalled work", "failed attempt", "context gap"],
    extraRetries: source?.extraRetries ?? 1,
    modelUpgradeTo: normalizeAgentModel(source?.modelUpgradeTo, "reviewer"),
    escalationBehavior: source?.escalationBehavior ?? "ask-user",
    status: source?.status ?? "watching",
  };
}

function normalizeEnvironmentVariables(value: unknown): EnvironmentVariable[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as Partial<EnvironmentVariable>;
    if (typeof candidate.key !== "string" || typeof candidate.value !== "string") return [];
    return [{
      id: typeof candidate.id === "string" && candidate.id ? candidate.id : `environment-${index}`,
      key: candidate.key,
      value: candidate.value,
    }];
  });
}

function defaultRunConfiguration(): WorkflowRunConfiguration {
  return {
    mode: "single",
    schedule: { days: [1, 2, 3, 4, 5], times: ["09:00"], timezone: "UTC" },
    webhook: { token: globalThis.crypto.randomUUID().replace(/-/g, ""), parameters: [] },
  };
}

function normalizeRunConfiguration(value: unknown): WorkflowRunConfiguration {
  const fallback = defaultRunConfiguration();
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<WorkflowRunConfiguration>;
  const schedule = candidate.schedule;
  const webhook = candidate.webhook;
  const days = Array.isArray(schedule?.days)
    ? Array.from(new Set(schedule.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)))
    : fallback.schedule.days;
  const times = Array.isArray(schedule?.times)
    ? Array.from(new Set(schedule.times.filter((time) => typeof time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(time)))).sort()
    : fallback.schedule.times;
  const parameters = Array.isArray(webhook?.parameters)
    ? webhook.parameters.flatMap((parameter, index) => {
      if (!parameter || typeof parameter !== "object") return [];
      const item = parameter as { id?: unknown; key?: unknown; defaultValue?: unknown };
      if (typeof item.key !== "string" || typeof item.defaultValue !== "string") return [];
      return [{ id: typeof item.id === "string" && item.id ? item.id : `webhook-parameter-${index}`, key: item.key, defaultValue: item.defaultValue }];
    })
    : [];
  return {
    mode: ["single", "scheduled", "webhook"].includes(candidate.mode ?? "") ? candidate.mode as WorkflowRunConfiguration["mode"] : "single",
    schedule: {
      days: days.length ? days : fallback.schedule.days,
      times: times.length ? times : fallback.schedule.times,
      timezone: typeof schedule?.timezone === "string" && schedule.timezone ? schedule.timezone : fallback.schedule.timezone,
    },
    webhook: {
      token: typeof webhook?.token === "string" && /^[a-zA-Z0-9_-]{12,128}$/.test(webhook.token) ? webhook.token : fallback.webhook.token,
      parameters,
    },
  };
}

export function normalizeWorkflow(workflow: Workflow): Workflow {
  const nodes = workflow.nodes.map((node) => {
    const configuredModel = normalizeAgentModel(node.configuredModel, node.role);
    return {
      ...node,
      configuredModel,
      effectiveModel: normalizeAgentModel(node.effectiveModel ?? configuredModel, node.role),
      reasoningEffort: normalizeReasoningEffort(node.reasoningEffort, node.role),
      retryPolicy: {
        ...node.retryPolicy,
        upgradeModelTo: normalizeAgentModel(node.retryPolicy?.upgradeModelTo, "reviewer"),
      },
      size: COMPACT_AGENT_SIZE,
    };
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return {
    ...workflow,
    executionBackend: workflow.executionBackend ?? "codex",
    runConfiguration: normalizeRunConfiguration(workflow.runConfiguration),
    defaultModel: normalizeAgentModel(workflow.defaultModel, "tester"),
    environmentVariables: normalizeEnvironmentVariables(workflow.environmentVariables),
    nodes,
    observers: [createLoopSupervisor(nodes, workflow.observers[0])],
    events: workflow.events.map((event) => {
      const model = (event.nodeId ? nodeById.get(event.nodeId)?.effectiveModel : undefined) ?? normalizeAgentModel(workflow.defaultModel, "tester");
      return {
        ...event,
        message: event.message.replace(LEGACY_MODEL_PATTERN, model),
        detail: event.detail?.replace(LEGACY_MODEL_PATTERN, model),
      };
    }),
    attentionRequests: Array.isArray(workflow.attentionRequests) ? workflow.attentionRequests : [],
    interventions: Array.isArray(workflow.interventions) ? workflow.interventions : [],
    runs: workflow.runs.map((run) => ({ ...run, source: run.source ?? "manual" })),
    threads: workflow.threads.map((thread) => ({
      ...thread,
      codex: thread.codex ?? { state: "disconnected" },
      model: nodeById.get(thread.nodeId)?.effectiveModel ?? normalizeAgentModel(thread.model),
      attempts: thread.attempts.map((attempt) => ({ ...attempt, model: normalizeAgentModel(attempt.model) })),
    })),
  };
}
