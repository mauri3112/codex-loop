export type TaskCapabilityKind = "skill" | "computer-use" | "mcp" | "app" | "cli" | "shell";

export interface TaskCapability {
  id: string;
  kind: TaskCapabilityKind;
  label: string;
  description: string;
  invocation: string;
  available: boolean;
  authStatus?: "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth" | "verified" | "unknown";
}

export interface TaskCapabilitiesResponse {
  items: TaskCapability[];
  source: "codex";
  warnings?: string[];
}
