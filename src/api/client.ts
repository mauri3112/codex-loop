import type { AppData, SingleRunOptions, Workflow, WorkflowDefinition, WorkflowRunConfiguration, WorkflowValidationIssue } from "../domain/types";
import type { TaskCapabilitiesResponse } from "../domain/task-capabilities";
import type { SimulationOptions, WorkflowSimulationReport } from "../domain/simulation-report";

export interface CreateInterventionInput {
  runId: string;
  idempotencyKey: string;
  delivery: "steer" | "queue" | "context";
  message: string;
  threadId?: string;
  expectedTurnId?: string;
  recipientNodeIds?: string[];
}

export interface RespondToAttentionInput {
  runId: string;
  expectedTurnId?: string;
  answers: Record<string, string | string[]>;
}

export interface BridgeStatus {
  state: "disconnected" | "connecting" | "connected" | "failed";
  error?: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (!response.ok) {
    const body = await response.text();
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error) throw new Error(parsed.error);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(body || `Request failed: ${response.status}`);
      throw error;
    }
    throw new Error(body || `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  data: () => request<AppData>("/api/data"),
  workflow: (id: string) => request<Workflow>(`/api/workflows/${id}`),
  generate: (task: string) => request<Workflow>("/api/workflows/generate", { method: "POST", body: JSON.stringify({ task }) }),
  create: () => request<Workflow>("/api/workflows", { method: "POST", body: JSON.stringify({}) }),
  update: (workflow: Workflow) => request<Workflow>(`/api/workflows/${workflow.id}`, { method: "PUT", body: JSON.stringify(workflow) }),
  save: (id: string) => request<Workflow>(`/api/workflows/${id}/save`, { method: "POST" }),
  validate: (id: string) => request<{ revision: number; issues: WorkflowValidationIssue[] }>(`/api/workflows/${id}/validate`, { method: "POST", body: JSON.stringify({}) }),
  mutate: (id: string, input: { baseRevision: number; actor: "user" | "designer" | "system" | "mcp"; rationale: string; definition: WorkflowDefinition }) => request<Workflow>(`/api/workflows/${id}/mutations`, { method: "POST", body: JSON.stringify(input) }),
  undo: (id: string, mutationId?: string) => request<Workflow>(`/api/workflows/${id}/undo`, { method: "POST", body: JSON.stringify({ mutationId }) }),
  sendDesignerMessage: (id: string, message: string) => request<Workflow>(`/api/workflows/${id}/designer/messages`, { method: "POST", body: JSON.stringify({ message }) }),
  createThread: (id: string, task: string) => request<Workflow>(`/api/workflows/${id}/threads`, { method: "POST", body: JSON.stringify({ task }) }),
  bridgeStatus: () => request<BridgeStatus>("/api/bridge/status"),
  connectBridge: () => request<BridgeStatus>("/api/bridge/connect", { method: "POST", body: JSON.stringify({}) }),
  taskCapabilities: () => request<TaskCapabilitiesResponse>("/api/task-capabilities"),
  simulate: (id: string, options?: SimulationOptions) => request<WorkflowSimulationReport>(`/api/workflows/${id}/simulate`, { method: "POST", body: JSON.stringify(options ?? {}) }),
  runAction: (id: string, action: "start" | "pause" | "resume" | "stop" | "reset", options?: SingleRunOptions) => request<Workflow>(`/api/workflows/${id}/run/${action}`, { method: "POST", body: JSON.stringify(options ?? {}) }),
  deleteWorkflow: (id: string) => request<{ deleted: true; id: string }>(`/api/workflows/${id}`, { method: "DELETE" }),
  configureRun: (id: string, runConfiguration: WorkflowRunConfiguration) => request<Workflow>(`/api/workflows/${id}/run-configuration`, { method: "PUT", body: JSON.stringify(runConfiguration) }),
  sendInstruction: (workflowId: string, threadId: string, instruction: string) => request<Workflow>(`/api/workflows/${workflowId}/threads/${threadId}/turn`, { method: "POST", body: JSON.stringify({ instruction }) }),
  stopThread: (workflowId: string, threadId: string) => request<Workflow>(`/api/workflows/${workflowId}/threads/${threadId}/stop`, { method: "POST", body: JSON.stringify({}) }),
  resolveApproval: (workflowId: string, threadId: string, decision: "accept" | "decline") => request<Workflow>(`/api/workflows/${workflowId}/threads/${threadId}/approval`, { method: "POST", body: JSON.stringify({ decision }) }),
  createIntervention: (workflowId: string, input: CreateInterventionInput) => request<Workflow>(`/api/workflows/${workflowId}/interventions`, { method: "POST", body: JSON.stringify(input) }),
  respondToAttention: (workflowId: string, attentionId: string, input: RespondToAttentionInput) => request<Workflow>(`/api/workflows/${workflowId}/attention/${attentionId}/respond`, { method: "POST", body: JSON.stringify(input) }),
  resolveGate: (workflowId: string, nodeId: string, decision: "approve" | "decline") => request<Workflow>(`/api/workflows/${workflowId}/gates/${nodeId}`, { method: "POST", body: JSON.stringify({ decision }) }),
};
