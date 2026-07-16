import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

type RequestId = string | number;

interface RpcRequest {
  method: string;
  id: RequestId;
  params?: unknown;
}

interface RpcNotification {
  method: string;
  params?: unknown;
}

interface RpcResponse {
  id: RequestId;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface AppServerNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface AppServerRequest extends AppServerNotification {
  id: RequestId;
}

export interface CodexAppServerOptions {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  onNotification?: (notification: AppServerNotification) => void | Promise<void>;
  onRequest?: (request: AppServerRequest) => void | Promise<void>;
  onStderr?: (line: string) => void;
}

export interface ThreadStartResult {
  thread: { id: string };
  model: string;
  cwd: string;
}

export interface TurnStartResult {
  turn: { id: string; status: string };
}

export class CodexAppServerClient {
  private process?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<RequestId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(private readonly options: CodexAppServerOptions = {}) {}

  setHandlers(handlers: Pick<CodexAppServerOptions, "onNotification" | "onRequest" | "onStderr">): void {
    this.options.onNotification = handlers.onNotification;
    this.options.onRequest = handlers.onRequest;
    this.options.onStderr = handlers.onStderr;
  }

  async connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.launch();
    try {
      await this.ready;
    } catch (error) {
      this.ready = undefined;
      throw error;
    }
  }

  private async launch(): Promise<void> {
    const command = this.options.command ?? process.env.CODEX_BINARY ?? "codex";
    const args = this.options.args ?? ["app-server", "--listen", "stdio://"];
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    const errors = readline.createInterface({ input: child.stderr });
    errors.on("line", (line) => this.options.onStderr?.(line));
    child.once("error", (error) => this.failAll(error));
    child.once("exit", (code, signal) => {
      this.process = undefined;
      this.ready = undefined;
      this.failAll(new Error(`codex app-server exited (${signal ?? code ?? "unknown"})`));
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await this.request("initialize", {
      clientInfo: { name: "codex_loop", title: "Codex Loop", version: "1.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized", {});
  }

  private handleLine(line: string): void {
    let message: RpcRequest | RpcNotification | RpcResponse;
    try {
      message = JSON.parse(line) as RpcRequest | RpcNotification | RpcResponse;
    } catch {
      this.options.onStderr?.(`Ignored non-JSON app-server output: ${line}`);
      return;
    }

    if ("id" in message && !("method" in message)) {
      const response = message as RpcResponse;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.error) pending.reject(new Error(response.error.message ?? `Codex request ${response.id} failed`));
      else pending.resolve(response.result);
      return;
    }

    if ("method" in message && "id" in message) {
      const request = message as RpcRequest;
      void this.options.onRequest?.({ id: request.id, method: request.method, params: asRecord(request.params) });
      return;
    }

    if ("method" in message) {
      const notification = message as RpcNotification;
      void this.options.onNotification?.({ method: notification.method, params: asRecord(notification.params) });
    }
  }

  private failAll(error: Error): void {
    this.pending.forEach((pending) => pending.reject(error));
    this.pending.clear();
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    if (method !== "initialize") await this.connect();
    const child = this.process;
    if (!child?.stdin.writable) throw new Error("codex app-server is not connected");
    const id = this.nextId++;
    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
    });
    child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    return response;
  }

  notify(method: string, params?: unknown): void {
    const child = this.process;
    if (!child?.stdin.writable) throw new Error("codex app-server is not connected");
    child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  respond(id: RequestId, result: unknown): void {
    const child = this.process;
    if (!child?.stdin.writable) throw new Error("codex app-server is not connected");
    child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  respondError(id: RequestId, code: number, message: string): void {
    const child = this.process;
    if (!child?.stdin.writable) throw new Error("codex app-server is not connected");
    child.stdin.write(`${JSON.stringify({ id, error: { code, message } })}\n`);
  }

  startThread(params: Record<string, unknown>): Promise<ThreadStartResult> {
    return this.request("thread/start", params);
  }

  resumeThread(threadId: string, params: Record<string, unknown> = {}): Promise<ThreadStartResult> {
    return this.request("thread/resume", { threadId, ...params });
  }

  setThreadName(threadId: string, name: string): Promise<unknown> {
    return this.request("thread/name/set", { threadId, name });
  }

  startTurn(params: Record<string, unknown>): Promise<TurnStartResult> {
    return this.request("turn/start", params);
  }

  steerTurn(threadId: string, expectedTurnId: string, text: string): Promise<unknown> {
    return this.request("turn/steer", { threadId, expectedTurnId, input: [textInput(text)] });
  }

  interruptTurn(threadId: string, turnId: string): Promise<unknown> {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  archiveThread(threadId: string): Promise<unknown> {
    return this.request("thread/archive", { threadId });
  }

  async close(): Promise<void> {
    const child = this.process;
    this.process = undefined;
    this.ready = undefined;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      if (!child.kill("SIGTERM") || child.exitCode !== null) resolve();
    });
  }
}

export function textInput(text: string) {
  return { type: "text", text, text_elements: [] };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
