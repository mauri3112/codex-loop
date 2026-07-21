export type AgentStatus = "idle" | "queued" | "running" | "waiting" | "blocked" | "failed" | "retrying" | "completed" | "skipped" | "stopped";
export type AgentRole = "investigator" | "implementer" | "tester" | "reviewer" | "custom";
export type AgentModel = "Sol" | "Terra" | "Luna";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type WorkflowStatus = "draft" | "ready" | "running" | "paused" | "stopped" | "completed" | "failed";
export type WorkflowLifecycle = "draft" | "published";
export type WorkflowStepKind = "agent" | "map" | "join" | "condition" | "loop" | "verify" | "gate" | "subworkflow";
export type Selection = { type: "workflow" | "agent" | "edge" | "observer" | "context"; id: string };
export type Point = { x: number; y: number };
export type Rect = Point & { width: number; height: number };

export interface AgentNode {
  id: string;
  threadId: string;
  name: string;
  role: AgentRole;
  task: string;
  definitionOfDone: string;
  configuredModel: AgentModel;
  effectiveModel: AgentModel;
  reasoningEffort?: ReasoningEffort;
  connectors: string[];
  readableContextBlockIds: string[];
  retryPolicy: { maxAttempts: number; upgradeModelTo: AgentModel };
  status: AgentStatus;
  attempt: number;
  progress: number;
  position: Point;
  size: { width: number; height: number };
  kind: WorkflowStepKind;
  orchestration?: {
    collectionExpression?: string;
    conditionExpression?: string;
    stopCondition?: string;
    maximumIterations?: number;
    subworkflowId?: string;
    verificationRubric?: string;
  };
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  trigger: "source-completed" | "source-settled" | "manual-approval";
  payload: string[];
  retries: number;
  failureBehavior: "block-target" | "continue-with-warning" | "ask-user";
  approvalRequired: boolean;
  status: "idle" | "active" | "waiting-approval" | "satisfied" | "skipped" | "failed";
}

export interface ObserverRegion {
  id: string;
  name: string;
  instructions: string;
  bounds: Rect;
  coveredNodeIds: string[];
  conditions: string[];
  extraRetries: number;
  modelUpgradeTo: AgentModel;
  escalationBehavior: "pause-workflow" | "ask-user" | "log-and-continue";
  status: "idle" | "watching" | "intervening";
}

export interface ContextBlock {
  id: string;
  title: string;
  summary: string;
  category: "repository-finding" | "acceptance-criteria" | "changed-files" | "test-results" | "architecture-decision" | "question" | "constraint";
  sourceThreadId?: string;
  createdBy: "manual" | "agent" | "system" | "observer";
  allowedAgentNodeIds: string[];
  estimatedTokens: number;
  createdAt: string;
  position: Point;
}

export type EventKind = "workflow" | "agent" | "tool" | "context" | "edge" | "observer" | "model" | "thread" | "approval" | "file" | "attention" | "intervention";
export interface AuditEvent {
  id: string;
  sequence: number;
  runId: string;
  kind: EventKind;
  type: string;
  actor: string;
  message: string;
  timestamp: string;
  logicalTime: number;
  nodeId?: string;
  edgeId?: string;
  observerId?: string;
  contextBlockId?: string;
  detail?: string;
}

export interface ThreadMessage { id: string; role: "user" | "assistant" | "system"; content: string; timestamp: string }
export interface ToolCall { id: string; name: string; command: string; output: string; status: "running" | "failed" | "completed" }
export interface FileChange { path: string; additions: number; deletions: number; summary: string }
export interface ExecutionAttempt { number: number; model: AgentModel; status: "running" | "failed" | "completed" | "stopped"; receivedContextBlockIds: string[]; summary: string }
export interface PendingApproval {
  requestId: string | number;
  type: "command" | "file-change";
  command?: string;
  reason?: string;
}

export type AttentionKind = "user-input" | "approval-gate" | "suspected-stall" | "deadlock" | "retry-exhausted" | "observer-escalation";
export interface AttentionQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
}
export interface AttentionRequest {
  id: string;
  runId: string;
  kind: AttentionKind;
  status: "open" | "resolved" | "dismissed" | "expired";
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  threadId?: string;
  nodeId?: string;
  expectedTurnId?: string;
  serverRequestId?: string | number;
  questions?: AttentionQuestion[];
  autoResolutionMs?: number | null;
  createdAt: string;
  resolvedAt?: string;
}

export type InterventionDelivery = "steer" | "queue" | "context";
export interface InterventionRecord {
  id: string;
  idempotencyKey: string;
  runId: string;
  delivery: InterventionDelivery;
  status: "pending" | "delivered" | "failed";
  message: string;
  threadId?: string;
  expectedTurnId?: string;
  recipientNodeIds?: string[];
  createdAt: string;
  deliveredAt?: string;
  error?: string;
}
export interface CodexThreadRuntime {
  threadId?: string;
  activeTurnId?: string;
  model?: string;
  cwd?: string;
  state: "disconnected" | "starting" | "running" | "idle" | "stopped" | "failed";
  lastError?: string;
}
export interface ThreadRecord {
  id: string;
  nodeId: string;
  title: string;
  task: string;
  definitionOfDone: string;
  model: AgentModel;
  connectors: string[];
  status: AgentStatus;
  messages: ThreadMessage[];
  toolCalls: ToolCall[];
  fileChanges: FileChange[];
  attempts: ExecutionAttempt[];
  finalOutput?: string;
  codex?: CodexThreadRuntime;
  pendingApproval?: PendingApproval;
  lastActivityAt?: string;
}

export interface WorkflowRun {
  id: string;
  status: "idle" | "running" | "paused" | "stopped" | "completed";
  step: number;
  source?: "manual" | "schedule" | "webhook";
  input?: Record<string, string | number | boolean | null>;
  additionalPrompt?: string;
  workingDirectory?: string;
  startedAt?: string;
  completedAt?: string;
  workflowRevision?: number;
  consumedAgents?: number;
  consumedIterations?: number;
  consumedTokens?: number;
  noProgressRounds?: number;
  lastProgressFingerprint?: string;
  checkpoints?: WorkflowCheckpoint[];
  repositoryRevision?: string;
  parentRun?: { workflowId: string; nodeId: string };
}

export interface SingleRunOptions {
  additionalPrompt?: string;
  workingDirectory?: string;
}

export interface WorkflowCheckpoint {
  id: string;
  nodeId: string;
  cacheKey: string;
  status: "completed" | "failed";
  outputSummary?: string;
  createdAt: string;
}

export interface RunScheduleConfiguration {
  days: number[];
  times: string[];
  timezone: string;
}

export interface WebhookParameter {
  id: string;
  key: string;
  defaultValue: string;
}

export interface WebhookRunConfiguration {
  token: string;
  parameters: WebhookParameter[];
}

export interface WorkflowRunConfiguration {
  mode: "single" | "scheduled" | "webhook";
  schedule: RunScheduleConfiguration;
  webhook: WebhookRunConfiguration;
}

export interface WorkflowConfigurationValue {
  id: string;
  key: string;
  value: string;
}

/** @deprecated Migrated to configurationValues or secretRequirements during normalization. */
export type EnvironmentVariable = WorkflowConfigurationValue;

export type CapabilityKind = "app" | "mcp" | "cli" | "computer-use" | "skill" | "shell";
export interface CapabilityBinding {
  id: string;
  kind: CapabilityKind;
  name: string;
  status: "available" | "setup-required" | "disabled";
  authStatus?: "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth" | "verified" | "unknown";
  provider?: string;
  requiredByNodeIds: string[];
}

export interface SecretRequirement {
  id: string;
  key: string;
  description: string;
  status: "required" | "bound";
  source?: "process-env" | "connector" | "keychain";
  sourceRef?: string;
  requiredByNodeIds: string[];
}

export interface WorkflowBudgets {
  maximumConcurrentAgents: number;
  maximumTotalAgents: number;
  maximumIterations: number;
  maximumWallClockMinutes: number;
  maximumTokens?: number;
  maximumNoProgressRounds: number;
}

export interface DesignerMessage extends ThreadMessage {
  status?: "complete" | "streaming" | "failed";
  mutationId?: string;
}

export interface DesignerState {
  threadId?: string;
  modelRole: "planner";
  configuredModel: string;
  effectiveModel?: string;
  state: "disconnected" | "starting" | "running" | "idle" | "waiting-input" | "failed";
  messages: DesignerMessage[];
  assumptions: string[];
  pendingQuestions: string[];
  lastError?: string;
}

export interface WorkflowDefinition {
  name: string;
  mainTask: string;
  defaultModel: AgentModel;
  executionMode: "automatic" | "approval-gated";
  sharedConnectors: string[];
  configurationValues: WorkflowConfigurationValue[];
  capabilityBindings: CapabilityBinding[];
  secretRequirements: SecretRequirement[];
  approvalPolicy: "never" | "on-risk" | "every-handoff";
  maximumRetries: number;
  executionBackend?: "codex" | "simulation";
  runConfiguration: WorkflowRunConfiguration;
  budgets: WorkflowBudgets;
  nodes: AgentNode[];
  edges: WorkflowEdge[];
  observers: ObserverRegion[];
  contextBlocks: ContextBlock[];
  viewport: { x: number; y: number; zoom: number };
}

export interface WorkflowMutation {
  id: string;
  baseRevision: number;
  revision: number;
  actor: "user" | "designer" | "system" | "mcp";
  rationale: string;
  before: WorkflowDefinition;
  after: WorkflowDefinition;
  createdAt: string;
  undoneMutationId?: string;
}

export interface WorkflowValidationIssue {
  id: string;
  severity: "error" | "warning";
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface Workflow {
  schemaVersion: 2;
  id: string;
  revision: number;
  lifecycle: WorkflowLifecycle;
  name: string;
  mainTask: string;
  defaultModel: AgentModel;
  executionMode: "automatic" | "approval-gated";
  sharedConnectors: string[];
  configurationValues: WorkflowConfigurationValue[];
  capabilityBindings: CapabilityBinding[];
  secretRequirements: SecretRequirement[];
  approvalPolicy: "never" | "on-risk" | "every-handoff";
  maximumRetries: number;
  budgets: WorkflowBudgets;
  executionBackend?: "codex" | "simulation";
  runConfiguration: WorkflowRunConfiguration;
  status: WorkflowStatus;
  saved: boolean;
  nodes: AgentNode[];
  edges: WorkflowEdge[];
  observers: ObserverRegion[];
  contextBlocks: ContextBlock[];
  threads: ThreadRecord[];
  runs: WorkflowRun[];
  events: AuditEvent[];
  attentionRequests: AttentionRequest[];
  interventions: InterventionRecord[];
  designer: DesignerState;
  mutations: WorkflowMutation[];
  validationIssues: WorkflowValidationIssue[];
  viewport: { x: number; y: number; zoom: number };
  createdAt: string;
  updatedAt: string;
}

export interface AppData {
  workflows: Workflow[];
  templates: Array<{ id: string; title: string; description: string }>;
  manualThreads: Array<{ id: string; title: string; status: AgentStatus }>;
}
