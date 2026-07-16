import type { AgentNode, ContextBlock } from "./types";

export function nextRunContextForAgent(contexts: ContextBlock[], agent?: AgentNode): ContextBlock[] {
  if (!agent) return contexts;
  const readableContextIds = new Set(agent.readableContextBlockIds);
  return contexts.filter((context) => readableContextIds.has(context.id));
}

export function nextRunRecipientsForContext(contextId: string, agents: AgentNode[]): AgentNode[] {
  return agents.filter((agent) => agent.readableContextBlockIds.includes(contextId));
}
