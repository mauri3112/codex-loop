import type { AppData, Workflow, WorkflowRunConfiguration } from "../domain/types";
import type { TaskCapabilitiesResponse } from "../domain/task-capabilities";

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
  bridgeStatus: () => request<BridgeStatus>("/api/bridge/status"),
  connectBridge: () => request<BridgeStatus>("/api/bridge/connect", { method: "POST", body: JSON.stringify({}) }),
  taskCapabilities: () => request<TaskCapabilitiesResponse>("/api/task-capabilities"),
  runAction: (id: string, action: "start" | "pause" | "resume" | "stop" | "reset") => request<Workflow>(`/api/workflows/${id}/run/${action}`, { method: "POST", body: JSON.stringify({}) }),
  configureRun: (id: string, runConfiguration: WorkflowRunConfiguration) => request<Workflow>(`/api/workflows/${id}/run-configuration`, { method: "PUT", body: JSON.stringify(runConfiguration) }),
  sendInstruction: (workflowId: string, threadId: string, instruction: string) => request<Workflow>(`/api/workflows/${workflowId}/threads/${threadId}/turn`, { method: "POST", body: JSON.stringify({ instruction }) }),
  stopThread: (workflowId: string, threadId: string) => request<Workflow>(`/api/workflows/${workflowId}/threads/${threadId}/stop`, { method: "POST", body: JSON.stringify({}) }),
  resolveApproval: (workflowId: string, threadId: string, decision: "accept" | "decline") => request<Workflow>(`/api/workflows/${workflowId}/threads/${threadId}/approval`, { method: "POST", body: JSON.stringify({ decision }) }),
  createIntervention: (workflowId: string, input: CreateInterventionInput) => request<Workflow>(`/api/workflows/${workflowId}/interventions`, { method: "POST", body: JSON.stringify(input) }),
  respondToAttention: (workflowId: string, attentionId: string, input: RespondToAttentionInput) => request<Workflow>(`/api/workflows/${workflowId}/attention/${attentionId}/respond`, { method: "POST", body: JSON.stringify(input) }),
};
