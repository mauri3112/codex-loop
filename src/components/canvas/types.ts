import type { Node, Edge } from "@xyflow/react";
import type {
  AgentNode,
  ContextBlock,
  ObserverRegion,
  Selection,
  WorkflowEdge,
} from "../../domain/types";

export type CanvasObjectKind = Exclude<Selection["type"], "workflow">;

export interface AgentNodeData extends Record<string, unknown> {
  kind: "agent";
  agent: AgentNode;
  order: number;
  onOpenThread?: (threadId: string) => void;
}

export interface ContextNodeData extends Record<string, unknown> {
  kind: "context";
  block: ContextBlock;
  agents: AgentNode[];
}

export interface ObserverNodeData extends Record<string, unknown> {
  kind: "observer";
  observer: ObserverRegion;
}

export interface WorkflowEdgeData extends Record<string, unknown> {
  edge: WorkflowEdge;
}

export type AgentFlowNode = Node<AgentNodeData, "agent">;
export type ContextFlowNode = Node<ContextNodeData, "context">;
export type ObserverFlowNode = Node<ObserverNodeData, "observer">;
export type LoopFlowNode = AgentFlowNode | ContextFlowNode | ObserverFlowNode;
export type LoopFlowEdge = Edge<WorkflowEdgeData, "workflow">;

export const flowId = {
  agent: (id: string) => `agent:${id}`,
  context: (id: string) => `context:${id}`,
  observer: (id: string) => `observer:${id}`,
  edge: (id: string) => `edge:${id}`,
};

export function parseFlowId(id: string): { kind: CanvasObjectKind; id: string } | null {
  const separator = id.indexOf(":");
  if (separator === -1) return null;
  const kind = id.slice(0, separator);
  if (kind !== "agent" && kind !== "context" && kind !== "observer" && kind !== "edge") return null;
  return { kind, id: id.slice(separator + 1) };
}
