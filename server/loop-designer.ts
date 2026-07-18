import path from "node:path";
import type { TaskCapabilitiesResponse, TaskCapability } from "../src/domain/task-capabilities.js";
import type {
  AgentModel,
  AgentNode,
  CapabilityBinding,
  SecretRequirement,
  Workflow,
  WorkflowDefinition,
  WorkflowStepKind,
} from "../src/domain/types.js";
import { workflowDefinition } from "../src/domain/definition.js";
import { createLoopSupervisor } from "../src/domain/normalize.js";
import { CodexAppServerClient, type AppServerNotification, type AppServerRequest, textInput } from "./codex-app-server.js";
import type { CodexBridgeService } from "./codex-bridge.js";
import { JsonWorkflowStore } from "./store.js";

export interface LoopDesignerService {
  sendMessage(workflowId: string, message: string): Promise<Workflow>;
  close?(): Promise<void>;
}

interface ProposalStep {
  key: string;
  name: string;
  kind: WorkflowStepKind;
  role: AgentNode["role"];
  task: string;
  definitionOfDone: string;
  model: AgentModel;
  reasoningEffort: NonNullable<AgentNode["reasoningEffort"]>;
  dependsOn: string[];
  capabilities: string[];
  orchestration?: AgentNode["orchestration"];
}

interface DesignerProposal {
  response: string;
  name: string;
  objective: string;
  assumptions: string[];
  questions: string[];
  steps: ProposalStep[];
  secretRequirements: Array<{ key: string; description: string; requiredBy: string[] }>;
  budgets?: Partial<Workflow["budgets"]>;
}

interface PendingTurn {
  workflowId: string;
  nativeThreadId: string;
  output: string;
  resolve: (proposal: DesignerProposal) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

const proposalSchema = {
  type: "object",
  additionalProperties: false,
  required: ["response", "name", "objective", "assumptions", "questions", "steps", "secretRequirements"],
  properties: {
    response: { type: "string" },
    name: { type: "string" },
    objective: { type: "string" },
    assumptions: { type: "array", items: { type: "string" } },
    questions: { type: "array", maxItems: 3, items: { type: "string" } },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "name", "kind", "role", "task", "definitionOfDone", "model", "reasoningEffort", "dependsOn", "capabilities"],
        properties: {
          key: { type: "string" }, name: { type: "string" }, kind: { enum: ["agent", "map", "join", "condition", "loop", "verify", "gate", "subworkflow"] },
          role: { enum: ["investigator", "implementer", "tester", "reviewer", "custom"] }, task: { type: "string" }, definitionOfDone: { type: "string" },
          model: { enum: ["Sol", "Terra", "Luna"] }, reasoningEffort: { enum: ["low", "medium", "high", "xhigh", "max"] },
          dependsOn: { type: "array", items: { type: "string" } }, capabilities: { type: "array", items: { type: "string" } },
          orchestration: {
            type: "object", additionalProperties: false,
            properties: {
              collectionExpression: { type: "string" }, conditionExpression: { type: "string" }, stopCondition: { type: "string" },
              maximumIterations: { type: "integer", minimum: 1 }, subworkflowId: { type: "string" }, verificationRubric: { type: "string" },
            },
          },
        },
      },
    },
    secretRequirements: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["key", "description", "requiredBy"], properties: { key: { type: "string" }, description: { type: "string" }, requiredBy: { type: "array", items: { type: "string" } } } },
    },
    budgets: {
      type: "object", additionalProperties: false,
      properties: {
        maximumConcurrentAgents: { type: "integer", minimum: 1, maximum: 16 }, maximumTotalAgents: { type: "integer", minimum: 1, maximum: 1000 },
        maximumIterations: { type: "integer", minimum: 1 }, maximumWallClockMinutes: { type: "integer", minimum: 1 },
        maximumTokens: { type: "integer", minimum: 1 }, maximumNoProgressRounds: { type: "integer", minimum: 1 },
      },
    },
  },
} as const;

const now = () => new Date().toISOString();
const makeId = (prefix: string) => `${prefix}-${globalThis.crypto.randomUUID()}`;

export class CodexLoopDesigner implements LoopDesignerService {
  private readonly client: CodexAppServerClient;
  private readonly nativeThreads = new Map<string, string>();
  private readonly pending = new Map<string, PendingTurn>();

  constructor(private readonly store: JsonWorkflowStore, private readonly bridge: Pick<CodexBridgeService, "listTaskCapabilities">, client = new CodexAppServerClient()) {
    this.client = client;
    this.client.setHandlers({
      onNotification: (notification) => this.handleNotification(notification),
      onRequest: (request) => this.handleRequest(request),
      onExit: (error) => this.handleExit(error),
      onStderr: (line) => { if (/\b(error|warn)/i.test(line)) console.warn(`[loop designer] ${line}`); },
    });
  }

  async sendMessage(workflowId: string, message: string): Promise<Workflow> {
    const text = message.trim();
    if (!text) throw new Error("Designer message cannot be empty");
    let workflow = await this.store.mutateWorkflow(workflowId, (draft) => {
      if (draft.designer.state === "running" || draft.designer.state === "starting") throw new Error("The Loop Designer is already working");
      draft.designer.state = "starting";
      draft.designer.lastError = undefined;
      draft.designer.messages.push({ id: makeId("designer-user"), role: "user", content: text, timestamp: now(), status: "complete" });
    });

    try {
      const capabilities = await this.bridge.listTaskCapabilities?.().catch(() => ({ items: [], source: "codex" as const, warnings: ["Capability inventory is unavailable"] })) ?? { items: [], source: "codex" as const };
      const nativeThreadId = await this.ensureThread(workflow);
      await this.store.mutateWorkflow(workflowId, (draft) => { draft.designer.state = "running"; });
      const proposalPromise = this.waitForProposal(workflowId, nativeThreadId);
      try {
        await this.client.startTurn({
          threadId: nativeThreadId,
          input: [textInput(buildDesignerPrompt(workflow, text, capabilities))],
          effort: "xhigh",
          outputSchema: proposalSchema,
          responsesapiClientMetadata: { codex_loop_workflow_id: workflow.id, codex_loop_role: "designer" },
        });
      } catch (error) {
        this.rejectPending(nativeThreadId, error instanceof Error ? error : new Error("Could not start the Loop Designer turn"));
        await proposalPromise.catch(() => undefined);
        throw error;
      }
      const proposal = await proposalPromise;
      workflow = await this.applyProposal(workflowId, proposal, capabilities);
      return workflow;
    } catch (error) {
      await this.store.mutateWorkflow(workflowId, (draft) => {
        draft.designer.state = "failed";
        draft.designer.lastError = errorMessage(error);
        draft.designer.messages.push({ id: makeId("designer-error"), role: "assistant", content: `I could not update this Loop: ${errorMessage(error)}`, timestamp: now(), status: "failed" });
      });
      throw error;
    }
  }

  private async ensureThread(workflow: Workflow): Promise<string> {
    await this.client.connect();
    const cwd = path.resolve(process.env.CODEX_LOOP_WORKSPACE ?? process.cwd());
    if (workflow.designer.threadId) {
      try {
        const resumed = await this.client.resumeThread(workflow.designer.threadId, { cwd, excludeTurns: true });
        this.nativeThreads.set(resumed.thread.id, workflow.id);
        return resumed.thread.id;
      } catch {
        this.nativeThreads.delete(workflow.designer.threadId);
      }
    }
    const configuredModel = process.env.CODEX_LOOP_DESIGNER_MODEL?.trim() || workflow.designer.configuredModel || "gpt-5.6-sol";
    const started = await this.client.startThread({
      cwd,
      model: configuredModel,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
      developerInstructions: "You are the Codex Loop Designer. Design and revise bounded, verifiable multi-agent workflows. You may inspect the repository read-only. Never edit files, start a run, request credentials, or put secret values in output. Ask at most three questions and only when an answer materially changes safety, architecture, access, cost, or the definition of done. Return only the requested structured proposal.",
    });
    this.nativeThreads.set(started.thread.id, workflow.id);
    await this.client.setThreadName(started.thread.id, `${workflow.name} · Loop Designer`).catch(() => undefined);
    await this.store.mutateWorkflow(workflow.id, (draft) => {
      draft.designer.threadId = started.thread.id;
      draft.designer.effectiveModel = started.model;
    });
    return started.thread.id;
  }

  private waitForProposal(workflowId: string, nativeThreadId: string): Promise<DesignerProposal> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(nativeThreadId);
        reject(new Error("Loop Designer timed out"));
      }, 180_000);
      this.pending.set(nativeThreadId, { workflowId, nativeThreadId, output: "", resolve, reject, timeout });
    });
  }

  private async applyProposal(workflowId: string, proposal: DesignerProposal, capabilities: TaskCapabilitiesResponse): Promise<Workflow> {
    let workflow = await this.store.getWorkflow(workflowId);
    let mutationId: string | undefined;
    if (proposal.steps.length) {
      const definition = compileProposal(workflow, proposal, capabilities.items);
      workflow = await this.store.applyDefinitionMutation(workflowId, definition, {
        baseRevision: workflow.revision,
        actor: "designer",
        rationale: proposal.response || "Updated from Designer chat",
      });
      mutationId = workflow.mutations.at(-1)?.id;
    }
    return this.store.mutateWorkflow(workflowId, (draft) => {
      draft.designer.state = proposal.questions.length ? "waiting-input" : "idle";
      draft.designer.assumptions = proposal.assumptions;
      draft.designer.pendingQuestions = proposal.questions;
      draft.designer.messages.push({ id: makeId("designer-assistant"), role: "assistant", content: proposal.response, timestamp: now(), status: "complete", mutationId });
    });
  }

  private async handleNotification(notification: AppServerNotification): Promise<void> {
    const nativeThreadId = stringValue(notification.params.threadId);
    const pending = this.pending.get(nativeThreadId);
    if (!pending) return;
    if (notification.method === "item/agentMessage/delta") {
      pending.output += stringValue(notification.params.delta);
      return;
    }
    if (notification.method === "item/completed") {
      const item = asRecord(notification.params.item);
      if (stringValue(item.type) === "agentMessage" && stringValue(item.text)) pending.output = stringValue(item.text);
      return;
    }
    if (notification.method === "turn/completed") {
      clearTimeout(pending.timeout);
      this.pending.delete(nativeThreadId);
      const turn = asRecord(notification.params.turn);
      if (stringValue(turn.status) !== "completed") {
        pending.reject(new Error(stringValue(asRecord(turn.error).message) || `Designer turn ${stringValue(turn.status) || "failed"}`));
        return;
      }
      try {
        pending.resolve(parseProposal(pending.output));
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error("Designer returned an invalid proposal"));
      }
    }
  }

  private handleRequest(request: AppServerRequest): void {
    this.client.respondError(request.id, -32601, "The read-only Loop Designer cannot use interactive or mutating tools");
  }

  private handleExit(error: Error): void {
    for (const pending of Array.from(this.pending.values())) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private rejectPending(nativeThreadId: string, error: Error): void {
    const pending = this.pending.get(nativeThreadId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(nativeThreadId);
    pending.reject(error);
  }

  async close(): Promise<void> {
    this.handleExit(new Error("Loop Designer stopped"));
    await this.client.close();
  }
}

function buildDesignerPrompt(workflow: Workflow, message: string, capabilities: TaskCapabilitiesResponse): string {
  const current = workflowDefinition(workflow);
  current.configurationValues = current.configurationValues.map((value) => ({ ...value, value: /token|secret|password|key/i.test(value.key) ? "[redacted-misclassified-secret]" : value.value }));
  const capabilitySummary = capabilities.items.map((item) => ({ id: item.id, kind: item.kind, name: item.label, available: item.available, authStatus: item.authStatus ?? "unknown" }));
  return [
    "Update the Loop in response to the user's message.",
    "Return the complete desired step list, not a patch. Preserve useful existing work unless the user asks to replace it.",
    "Use capabilities only when they are available. If access is missing, describe setup in questions or assumptions; never request a credential value.",
    "Every loop must have measurable verification, a bounded stop condition for repeating work, and conservative budgets.",
    `User message:\n${message}`,
    `Current Loop definition:\n${JSON.stringify(current)}`,
    `Runtime capabilities:\n${JSON.stringify(capabilitySummary)}`,
  ].join("\n\n");
}

function compileProposal(workflow: Workflow, proposal: DesignerProposal, capabilities: TaskCapability[]): WorkflowDefinition {
  const current = workflowDefinition(workflow);
  const existingByKey = new Map(current.nodes.map((node) => [slug(node.name), node]));
  const keyToId = new Map<string, string>();
  const steps = proposal.steps.slice(0, workflow.budgets.maximumTotalAgents);
  for (const step of steps) {
    const existing = existingByKey.get(slug(step.key)) ?? existingByKey.get(slug(step.name));
    keyToId.set(step.key, existing?.id ?? `${workflow.id}-step-${slug(step.key) || globalThis.crypto.randomUUID().slice(0, 8)}`);
  }
  const nodes = steps.map((step, index): AgentNode => {
    const id = keyToId.get(step.key) as string;
    const existing = current.nodes.find((node) => node.id === id);
    return {
      id,
      threadId: existing?.threadId ?? `${workflow.id}-thread-${slug(step.key) || index + 1}`,
      name: step.name,
      role: step.role,
      task: step.task,
      definitionOfDone: step.definitionOfDone,
      configuredModel: step.model,
      effectiveModel: step.model,
      reasoningEffort: step.reasoningEffort,
      connectors: [...step.capabilities],
      readableContextBlockIds: existing?.readableContextBlockIds ?? [],
      retryPolicy: existing?.retryPolicy ?? { maxAttempts: 2, upgradeModelTo: "Sol" },
      status: "idle",
      attempt: 0,
      progress: 0,
      position: existing?.position ?? { x: 80 + (index % 3) * 300, y: 100 + Math.floor(index / 3) * 210 },
      size: existing?.size ?? { width: 100, height: 108 },
      kind: step.kind,
      orchestration: step.orchestration,
    };
  });
  const edges = steps.flatMap((step) => step.dependsOn.flatMap((dependency, dependencyIndex) => {
    const source = keyToId.get(dependency);
    const target = keyToId.get(step.key);
    if (!source || !target) return [];
    return [{
      id: `${workflow.id}-edge-${slug(dependency)}-${slug(step.key)}-${dependencyIndex}`,
      source, target, trigger: "source-completed" as const, payload: ["final-output"], retries: 0,
      failureBehavior: "block-target" as const, approvalRequired: step.kind === "gate", status: "idle" as const,
    }];
  }));
  const capabilityBindings: CapabilityBinding[] = unique(steps.flatMap((step) => step.capabilities)).map((name) => {
    const capability = capabilities.find((candidate) => candidate.id === name || candidate.label.toLowerCase() === name.toLowerCase());
    return {
      id: capability?.id ?? `requirement:${slug(name)}`,
      kind: capability?.kind === "computer-use" ? "computer-use" : capability?.kind ?? "mcp",
      name: capability?.label ?? name,
      status: capability?.available ? "available" : "setup-required",
      authStatus: capability?.authStatus ?? "unknown",
      requiredByNodeIds: steps.filter((step) => step.capabilities.includes(name)).map((step) => keyToId.get(step.key) as string),
    };
  });
  const secretRequirements: SecretRequirement[] = proposal.secretRequirements.map((secret) => ({
    id: `secret-${slug(secret.key)}`,
    key: secret.key,
    description: secret.description,
    status: "required",
    requiredByNodeIds: secret.requiredBy.flatMap((key) => keyToId.get(key) ?? []),
  }));
  const assumptionsBlockId = `${workflow.id}-designer-brief`;
  for (const node of nodes) node.readableContextBlockIds = unique([...node.readableContextBlockIds, assumptionsBlockId]);
  return {
    ...current,
    name: proposal.name.trim() || current.name,
    mainTask: proposal.objective.trim() || current.mainTask,
    nodes,
    edges,
    observers: [createLoopSupervisor(nodes, current.observers[0])],
    contextBlocks: [{
      id: assumptionsBlockId, title: "Designer brief", summary: [proposal.objective, ...proposal.assumptions.map((item) => `Assumption: ${item}`)].join("\n"),
      category: "acceptance-criteria", createdBy: "agent", allowedAgentNodeIds: nodes.map((node) => node.id), estimatedTokens: 300,
      createdAt: now(), position: { x: 80, y: 100 + Math.ceil(nodes.length / 3) * 210 },
    }],
    capabilityBindings,
    secretRequirements,
    sharedConnectors: capabilityBindings.map((binding) => binding.name),
    budgets: { ...current.budgets, ...proposal.budgets },
  };
}

function parseProposal(output: string): DesignerProposal {
  const value = JSON.parse(output) as Partial<DesignerProposal>;
  if (!value || typeof value.response !== "string" || !Array.isArray(value.steps) || !Array.isArray(value.questions) || !Array.isArray(value.assumptions) || !Array.isArray(value.secretRequirements)) {
    throw new Error("Loop Designer returned an invalid structured proposal");
  }
  return value as DesignerProposal;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 56);
}

function unique<T>(values: T[]): T[] { return Array.from(new Set(values)); }
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Unknown Loop Designer error"; }
