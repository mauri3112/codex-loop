import type { AppData, Workflow, WorkflowRunConfiguration } from "../domain/types";

export interface BridgeStatus {
  state: "disconnected" | "connecting" | "connected" | "failed";
  error?: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (!response.ok) throw new Error((await response.text()) || `Request failed: ${response.status}`);
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
  runAction: (id: string, action: "start" | "pause" | "resume" | "stop" | "reset") => request<Workflow>(`/api/workflows/${id}/run/${action}`, { method: "POST", body: JSON.stringify({}) }),
  configureRun: (id: string, runConfiguration: WorkflowRunConfiguration) => request<Workflow>(`/api/workflows/${id}/run-configuration`, { method: "PUT", body: JSON.stringify(runConfiguration) }),
  sendInstruction: (workflowId: string, threadId: string, instruction: string) => request<Workflow>(`/api/workflows/${workflowId}/threads/${threadId}/turn`, { method: "POST", body: JSON.stringify({ instruction }) }),
  stopThread: (workflowId: string, threadId: string) => request<Workflow>(`/api/workflows/${workflowId}/threads/${threadId}/stop`, { method: "POST", body: JSON.stringify({}) }),
  resolveApproval: (workflowId: string, threadId: string, decision: "accept" | "decline") => request<Workflow>(`/api/workflows/${workflowId}/threads/${threadId}/approval`, { method: "POST", body: JSON.stringify({ decision }) }),
};
