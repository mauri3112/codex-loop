import type { AgentModel, AgentRole, ReasoningEffort } from "./types";

export const AGENT_MODELS = ["Sol", "Terra", "Luna"] as const satisfies readonly AgentModel[];
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly ReasoningEffort[];

export function defaultModelForRole(role: AgentRole): AgentModel {
  if (role === "implementer" || role === "reviewer") return "Sol";
  if (role === "tester") return "Terra";
  return "Luna";
}

export function normalizeAgentModel(value: unknown, role: AgentRole = "custom"): AgentModel {
  if (typeof value === "string") {
    const match = AGENT_MODELS.find((model) => model.toLowerCase() === value.toLowerCase());
    if (match) return match;
  }
  return defaultModelForRole(role);
}

export function defaultReasoningEffort(role: AgentRole): ReasoningEffort {
  if (role === "implementer" || role === "reviewer") return "high";
  if (role === "tester") return "medium";
  return "low";
}

export function normalizeReasoningEffort(value: unknown, role: AgentRole): ReasoningEffort {
  return EFFORT_LEVELS.includes(value as ReasoningEffort)
    ? value as ReasoningEffort
    : defaultReasoningEffort(role);
}

export function effortLabel(effort: ReasoningEffort): string {
  if (effort === "xhigh") return "Extra high";
  return `${effort.slice(0, 1).toUpperCase()}${effort.slice(1)}`;
}
