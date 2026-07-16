import { createLoopSupervisor } from "./normalize";
import type { Workflow } from "./types";

export function removeAgentNode(workflow: Workflow, nodeId: string): Workflow {
  if (!workflow.nodes.some((node) => node.id === nodeId)) return workflow;

  const nodes = workflow.nodes.filter((node) => node.id !== nodeId);
  return {
    ...workflow,
    nodes,
    edges: workflow.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
    observers: [createLoopSupervisor(nodes, workflow.observers[0])],
    contextBlocks: workflow.contextBlocks.map((block) => ({
      ...block,
      allowedAgentNodeIds: block.allowedAgentNodeIds.filter((id) => id !== nodeId),
    })),
    threads: workflow.threads.filter((thread) => thread.nodeId !== nodeId),
  };
}
