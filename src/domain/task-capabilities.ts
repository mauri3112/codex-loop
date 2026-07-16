export type TaskCapabilityKind = "skill" | "computer-use" | "mcp";

export interface TaskCapability {
  id: string;
  kind: TaskCapabilityKind;
  label: string;
  description: string;
  invocation: string;
}

export interface TaskCapabilitiesResponse {
  items: TaskCapability[];
  source: "codex";
  warnings?: string[];
}
