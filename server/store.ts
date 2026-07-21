import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyWorkflowDefinition, createWorkflowMutation, validateWorkflowDefinition, workflowDefinition } from "../src/domain/definition.js";
import type { AppData, Workflow, WorkflowDefinition, WorkflowMutation } from "../src/domain/types.js";
import { normalizeWorkflow } from "../src/domain/normalize.js";
import { createInitialData } from "../src/data/seed.js";

export class WorkflowNotFoundError extends Error {
  constructor(id: string) {
    super(`Workflow ${id} was not found`);
    this.name = "WorkflowNotFoundError";
  }
}

export class WorkflowRevisionConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`Workflow revision conflict: expected ${expected}, current revision is ${actual}`);
    this.name = "WorkflowRevisionConflictError";
  }
}

export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowValidationError";
  }
}

export class JsonWorkflowStore {
  private data: AppData | undefined;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath = path.resolve(process.cwd(), "data/codex-loop.json")) {}

  private async load(): Promise<AppData> {
    if (this.data) return this.data;

    try {
      const contents = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(contents) as AppData;
      if (!Array.isArray(parsed.workflows) || !Array.isArray(parsed.templates) || !Array.isArray(parsed.manualThreads)) {
        throw new Error("Persistent store has an invalid shape");
      }
      const normalized = { ...parsed, workflows: parsed.workflows.map(normalizeWorkflow) };
      this.data = normalized;
      if (JSON.stringify(normalized) !== JSON.stringify(parsed)) await this.persist(normalized);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      const initialData = createInitialData();
      this.data = initialData;
      await this.persist(initialData);
    }

    return this.data as AppData;
  }

  private async persist(data: AppData): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.filePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private async mutate<T>(operation: (data: AppData) => T | Promise<T>): Promise<T> {
    const pending = this.mutationQueue.then(async () => {
      const data = await this.load();
      const result = await operation(data);
      await this.persist(data);
      return result;
    });
    this.mutationQueue = pending.catch(() => undefined);
    return pending;
  }

  async getData(): Promise<AppData> {
    return structuredClone(await this.load());
  }

  async getWorkflow(id: string): Promise<Workflow> {
    const workflow = (await this.load()).workflows.find((item) => item.id === id);
    if (!workflow) throw new WorkflowNotFoundError(id);
    return structuredClone(workflow);
  }

  async addWorkflow(workflow: Workflow): Promise<Workflow> {
    return this.mutate((data) => {
      if (data.workflows.some((item) => item.id === workflow.id)) {
        throw new Error(`Workflow ${workflow.id} already exists`);
      }
      const normalized = normalizeWorkflow(structuredClone(workflow));
      data.workflows.unshift(normalized);
      return structuredClone(normalized);
    });
  }

  async deleteWorkflow(id: string): Promise<void> {
    await this.mutate((data) => {
      const index = data.workflows.findIndex((item) => item.id === id);
      if (index < 0) throw new WorkflowNotFoundError(id);
      if (["running", "paused"].includes(data.workflows[index].status)) {
        throw new WorkflowValidationError("Stop this Loop before deleting it");
      }
      data.workflows.splice(index, 1);
    });
  }

  async updateWorkflow(id: string, workflow: Workflow): Promise<Workflow> {
    return this.mutate((data) => {
      const index = data.workflows.findIndex((item) => item.id === id);
      if (index < 0) throw new WorkflowNotFoundError(id);
      const current = data.workflows[index];
      const incoming = structuredClone(workflow);
      const merged = ["running", "paused"].includes(current.status) ? preserveActiveRuntime(current, incoming) : incoming;
      const definition = workflowDefinition(normalizeWorkflow(merged));
      const before = workflowDefinition(current);
      if (JSON.stringify(before) === JSON.stringify(definition)) return structuredClone(current);
      const mutation = createWorkflowMutation(current, definition, { baseRevision: current.revision, actor: "user", rationale: "Updated in visual editor" });
      applyWorkflowDefinition(merged, definition);
      const updated = normalizeWorkflow({ ...merged, id, revision: mutation.revision, lifecycle: "draft", saved: false, mutations: [...current.mutations, mutation], updatedAt: new Date().toISOString() });
      data.workflows[index] = updated;
      return structuredClone(updated);
    });
  }

  async applyDefinitionMutation(
    id: string,
    definition: WorkflowDefinition,
    input: { baseRevision: number; actor: WorkflowMutation["actor"]; rationale: string; undoneMutationId?: string },
  ): Promise<Workflow> {
    return this.mutate((data) => {
      const index = data.workflows.findIndex((item) => item.id === id);
      if (index < 0) throw new WorkflowNotFoundError(id);
      const current = data.workflows[index];
      if (current.revision !== input.baseRevision) throw new WorkflowRevisionConflictError(input.baseRevision, current.revision);
      if (["running", "paused"].includes(current.status)) throw new WorkflowValidationError("Create a new draft revision before changing a running Loop");
      const mutation = createWorkflowMutation(current, definition, input);
      const next = structuredClone(current);
      applyWorkflowDefinition(next, mutation.after);
      next.revision = mutation.revision;
      next.lifecycle = "draft";
      next.saved = false;
      next.mutations.push(mutation);
      next.validationIssues = validateWorkflowDefinition(mutation.after);
      next.updatedAt = new Date().toISOString();
      const updated = normalizeWorkflow(next);
      data.workflows[index] = updated;
      return structuredClone(updated);
    });
  }

  async undoWorkflowMutation(id: string, mutationId?: string): Promise<Workflow> {
    const current = await this.getWorkflow(id);
    const mutation = mutationId
      ? current.mutations.find((candidate) => candidate.id === mutationId)
      : [...current.mutations].reverse().find((candidate) => !current.mutations.some((later) => later.undoneMutationId === candidate.id));
    if (!mutation) throw new WorkflowValidationError("There is no Loop change to undo");
    return this.applyDefinitionMutation(id, mutation.before, {
      baseRevision: current.revision,
      actor: "user",
      rationale: `Undo: ${mutation.rationale}`,
      undoneMutationId: mutation.id,
    });
  }

  async mutateWorkflow(id: string, operation: (workflow: Workflow) => void | Promise<void>): Promise<Workflow> {
    return this.mutate(async (data) => {
      const index = data.workflows.findIndex((item) => item.id === id);
      if (index < 0) throw new WorkflowNotFoundError(id);
      const workflow = structuredClone(data.workflows[index]);
      await operation(workflow);
      const updated = normalizeWorkflow({ ...workflow, id, updatedAt: new Date().toISOString() });
      data.workflows[index] = updated;
      return structuredClone(updated);
    });
  }

  async saveWorkflow(id: string): Promise<Workflow> {
    return this.mutate((data) => {
      const workflow = data.workflows.find((item) => item.id === id);
      if (!workflow) throw new WorkflowNotFoundError(id);
      const issues = validateWorkflowDefinition(workflowDefinition(workflow));
      workflow.validationIssues = issues;
      if (issues.some((issue) => issue.severity === "error")) throw new WorkflowValidationError("Resolve Loop validation errors before publishing");
      workflow.saved = true;
      workflow.lifecycle = "published";
      if (workflow.status === "draft") workflow.status = "ready";
      workflow.updatedAt = new Date().toISOString();
      return structuredClone(workflow);
    });
  }
}

function preserveActiveRuntime(current: Workflow, incoming: Workflow): Workflow {
  const currentNodes = new Map(current.nodes.map((node) => [node.id, node]));
  const currentEdges = new Map(current.edges.map((edge) => [edge.id, edge]));
  const currentObservers = new Map(current.observers.map((observer) => [observer.id, observer]));
  const currentThreads = new Map(current.threads.map((thread) => [thread.id, thread]));
  const incomingContextIds = new Set(incoming.contextBlocks.map((block) => block.id));
  return {
    ...incoming,
    status: current.status,
    nodes: incoming.nodes.map((node) => {
      const runtime = currentNodes.get(node.id);
      return runtime ? { ...node, effectiveModel: runtime.effectiveModel, readableContextBlockIds: runtime.readableContextBlockIds, status: runtime.status, attempt: runtime.attempt, progress: runtime.progress } : node;
    }),
    edges: incoming.edges.map((edge) => ({ ...edge, status: currentEdges.get(edge.id)?.status ?? edge.status })),
    observers: incoming.observers.map((observer) => ({ ...observer, status: currentObservers.get(observer.id)?.status ?? observer.status })),
    contextBlocks: [
      ...incoming.contextBlocks,
      ...current.contextBlocks.filter((block) => !incomingContextIds.has(block.id)),
    ],
    threads: incoming.threads.map((thread) => {
      const runtime = currentThreads.get(thread.id);
      return runtime ? {
        ...thread,
        status: runtime.status,
        messages: runtime.messages,
        toolCalls: runtime.toolCalls,
        fileChanges: runtime.fileChanges,
        attempts: runtime.attempts,
        finalOutput: runtime.finalOutput,
        codex: runtime.codex,
        pendingApproval: runtime.pendingApproval,
        lastActivityAt: runtime.lastActivityAt,
      } : thread;
    }),
    runs: current.runs,
    events: current.events,
    attentionRequests: current.attentionRequests,
    interventions: current.interventions,
  };
}
