import { normalizeAgentModel, normalizeReasoningEffort } from "./models";
import { validateWorkflowDefinition, workflowDefinition } from "./definition";
import type { AgentNode, EnvironmentVariable, ObserverRegion, Rect, SecretRequirement, Workflow, WorkflowBudgets, WorkflowRunConfiguration } from "./types";

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

function defaultBudgets(): WorkflowBudgets {
  return {
    maximumConcurrentAgents: 4,
    maximumTotalAgents: 32,
    maximumIterations: 12,
    maximumWallClockMinutes: 120,
    maximumNoProgressRounds: 2,
  };
}

function normalizeBudgets(value: unknown): WorkflowBudgets {
  const fallback = defaultBudgets();
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<WorkflowBudgets>;
  const integer = (input: unknown, defaultValue: number, minimum: number, maximum: number) =>
    typeof input === "number" && Number.isInteger(input) ? Math.min(maximum, Math.max(minimum, input)) : defaultValue;
  return {
    maximumConcurrentAgents: integer(candidate.maximumConcurrentAgents, fallback.maximumConcurrentAgents, 1, 16),
    maximumTotalAgents: integer(candidate.maximumTotalAgents, fallback.maximumTotalAgents, 1, 1_000),
    maximumIterations: integer(candidate.maximumIterations, fallback.maximumIterations, 1, 1_000),
    maximumWallClockMinutes: integer(candidate.maximumWallClockMinutes, fallback.maximumWallClockMinutes, 1, 10_080),
    maximumTokens: typeof candidate.maximumTokens === "number" && candidate.maximumTokens > 0 ? Math.floor(candidate.maximumTokens) : undefined,
    maximumNoProgressRounds: integer(candidate.maximumNoProgressRounds, fallback.maximumNoProgressRounds, 1, 20),
  };
}

function migrateLegacyEnvironmentVariables(workflow: Workflow): SecretRequirement[] {
  const legacy = normalizeEnvironmentVariables((workflow as unknown as { environmentVariables?: unknown }).environmentVariables);
  return legacy.filter((entry) => entry.key.trim()).map((entry) => ({
    id: `secret-${entry.id}`,
    key: entry.key.trim(),
    description: `Migrated environment requirement for ${entry.key.trim()}`,
    status: "required",
    requiredByNodeIds: workflow.nodes.map((node) => node.id),
  }));
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
      kind: node.kind ?? "agent",
    };
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const existingThreads = new Map(workflow.threads.map((thread) => [thread.nodeId, thread]));
  const threads = nodes.map((node) => {
    const thread = existingThreads.get(node.id);
    if (thread) return {
      ...thread,
      id: node.threadId,
      nodeId: node.id,
      title: node.name,
      task: node.task,
      definitionOfDone: node.definitionOfDone,
      connectors: [...node.connectors],
    };
    return {
      id: node.threadId,
      nodeId: node.id,
      title: node.name,
      task: node.task,
      definitionOfDone: node.definitionOfDone,
      model: node.effectiveModel,
      connectors: [...node.connectors],
      status: "idle" as const,
      messages: [{ id: `${node.threadId}-assignment`, role: "system" as const, content: `Assigned by Codex Loop: ${node.task}`, timestamp: new Date().toISOString() }],
      toolCalls: [],
      fileChanges: [],
      attempts: [],
      codex: { state: "disconnected" as const },
    };
  });
  const normalized = {
    ...workflow,
    schemaVersion: 2 as const,
    revision: Number.isInteger(workflow.revision) && workflow.revision >= 0 ? workflow.revision : 0,
    lifecycle: workflow.lifecycle ?? (workflow.saved ? "published" : "draft"),
    executionBackend: workflow.executionBackend ?? "codex",
    runConfiguration: normalizeRunConfiguration(workflow.runConfiguration),
    defaultModel: normalizeAgentModel(workflow.defaultModel, "tester"),
    configurationValues: Array.isArray(workflow.configurationValues) ? normalizeEnvironmentVariables(workflow.configurationValues) : [],
    capabilityBindings: Array.isArray(workflow.capabilityBindings) ? workflow.capabilityBindings : [],
    secretRequirements: Array.isArray(workflow.secretRequirements) ? workflow.secretRequirements : migrateLegacyEnvironmentVariables(workflow),
    budgets: normalizeBudgets(workflow.budgets),
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
    runs: workflow.runs.map((run) => ({
      ...run,
      source: run.source ?? "manual",
      consumedAgents: Math.max(0, run.consumedAgents ?? 0),
      consumedIterations: Math.max(0, run.consumedIterations ?? 0),
      consumedTokens: Math.max(0, run.consumedTokens ?? 0),
      noProgressRounds: Math.max(0, run.noProgressRounds ?? 0),
      checkpoints: Array.isArray(run.checkpoints) ? run.checkpoints : [],
      threadResults: Array.isArray(run.threadResults) ? run.threadResults : [],
      events: Array.isArray(run.events) ? run.events : [],
    })),
    threads: threads.map((thread) => ({
      ...thread,
      codex: thread.codex ?? { state: "disconnected" },
      model: nodeById.get(thread.nodeId)?.effectiveModel ?? normalizeAgentModel(thread.model),
      attempts: thread.attempts.map((attempt) => ({ ...attempt, model: normalizeAgentModel(attempt.model) })),
    })),
    designer: workflow.designer ?? {
      modelRole: "planner" as const,
      configuredModel: "gpt-5.6-sol",
      state: "disconnected" as const,
      messages: [],
      assumptions: [],
      pendingQuestions: [],
    },
    mutations: Array.isArray(workflow.mutations) ? workflow.mutations : [],
    validationIssues: [] as Workflow["validationIssues"],
  };
  normalized.validationIssues = validateWorkflowDefinition(workflowDefinition(normalized));
  return normalized;
}
