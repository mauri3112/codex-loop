import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppData, Workflow } from "../src/domain/types.js";
import { normalizeWorkflow } from "../src/domain/normalize.js";
import { createInitialData } from "../src/data/seed.js";

export class WorkflowNotFoundError extends Error {
  constructor(id: string) {
    super(`Workflow ${id} was not found`);
    this.name = "WorkflowNotFoundError";
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
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
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

  async updateWorkflow(id: string, workflow: Workflow): Promise<Workflow> {
    return this.mutate((data) => {
      const index = data.workflows.findIndex((item) => item.id === id);
      if (index < 0) throw new WorkflowNotFoundError(id);
      const current = data.workflows[index];
      const incoming = structuredClone(workflow);
      const merged = ["running", "paused"].includes(current.status) ? preserveActiveRuntime(current, incoming) : incoming;
      const updated = normalizeWorkflow({ ...merged, id, updatedAt: new Date().toISOString() });
      data.workflows[index] = updated;
      return structuredClone(updated);
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
      workflow.saved = true;
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
      } : thread;
    }),
    runs: current.runs,
    events: current.events,
  };
}
