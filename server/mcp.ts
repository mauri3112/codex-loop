import type { Request, Response } from "express";
import { createBlankWorkflow } from "../src/data/seed.js";
import { workflowDefinition } from "../src/domain/definition.js";
import type { WorkflowDefinition } from "../src/domain/types.js";
import type { CodexBridgeService } from "./codex-bridge.js";
import type { LoopDesignerService } from "./loop-designer.js";
import { JsonWorkflowStore } from "./store.js";

interface JsonRpcRequest { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

const tool = (name: string, description: string, inputSchema: Record<string, unknown>, readOnlyHint: boolean, destructiveHint = false) => ({
  name, description, inputSchema,
  annotations: { readOnlyHint, destructiveHint, idempotentHint: readOnlyHint, openWorldHint: false },
});

const tools = [
  tool("loop_list", "List Codex Loops and their current revision, lifecycle, and runtime status.", { type: "object", additionalProperties: false, properties: {} }, true),
  tool("loop_get", "Read one Codex Loop, including its definition, validation issues, and setup requirements.", { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } }, true),
  tool("loop_capabilities", "Read Codex skills, apps, MCP servers, CLI tools, and authentication availability visible to Loop.", { type: "object", additionalProperties: false, properties: {} }, true),
  tool("loop_validate", "Validate a Loop definition without changing it.", { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } }, true),
  tool("loop_create_draft", "Create an empty versioned Loop draft and return its deep link.", { type: "object", additionalProperties: false, properties: { name: { type: "string" }, objective: { type: "string" }, originThreadId: { type: "string" } } }, false),
  tool("loop_designer_message", "Ask the persistent Loop Designer to create or revise the graph from a natural-language request.", { type: "object", additionalProperties: false, required: ["id", "message"], properties: { id: { type: "string" }, message: { type: "string" } } }, false),
  tool("loop_patch_draft", "Apply a complete validated definition using optimistic revision locking.", { type: "object", additionalProperties: false, required: ["id", "baseRevision", "rationale", "definition"], properties: { id: { type: "string" }, baseRevision: { type: "integer", minimum: 0 }, rationale: { type: "string" }, definition: { type: "object" } } }, false),
  tool("loop_publish", "Publish a valid Loop revision. Publishing fails while validation errors remain.", { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } }, false),
  tool("loop_start", "Start a published or ready Loop. This can cause repository and external-system side effects.", { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } }, false, true),
  tool("loop_pause", "Pause scheduling new work in an active Loop.", { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } }, false),
  tool("loop_resume", "Resume an explicitly paused Loop.", { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } }, false, true),
  tool("loop_stop", "Stop an active Loop and interrupt its active agents.", { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } }, false, true),
  tool("loop_gate_decision", "Approve or decline a waiting human gate. Approval can allow consequential downstream work to begin.", { type: "object", additionalProperties: false, required: ["id", "nodeId", "decision"], properties: { id: { type: "string" }, nodeId: { type: "string" }, decision: { enum: ["approve", "decline"] } } }, false, true),
];

export async function handleMcpRequest(
  request: Request,
  response: Response,
  services: { store: JsonWorkflowStore; bridge: CodexBridgeService; designer: LoopDesignerService },
): Promise<void> {
  if (!mcpAuthorized(request)) {
    response.status(401).json({ error: "Codex Loop MCP authentication required" });
    return;
  }
  const rpc = request.body as JsonRpcRequest;
  if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
    response.status(400).json(rpcError(rpc?.id ?? null, -32600, "Invalid JSON-RPC request"));
    return;
  }
  if (rpc.method === "notifications/initialized") {
    response.status(202).end();
    return;
  }
  try {
    let result: unknown;
    if (rpc.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "codex-loop", title: "Codex Loop", version: "1.0.0" } };
    else if (rpc.method === "ping") result = {};
    else if (rpc.method === "tools/list") result = { tools };
    else if (rpc.method === "tools/call") {
      try {
        result = await callTool(String(rpc.params?.name ?? ""), asRecord(rpc.params?.arguments), services);
      } catch (error) {
        const code = typeof (error as { rpcCode?: unknown }).rpcCode === "number" ? (error as { rpcCode: number }).rpcCode : -32000;
        result = toolError(errorMessage(error), code);
      }
    } else {
      response.json(rpcError(rpc.id ?? null, -32601, `Method ${rpc.method} not found`));
      return;
    }
    response.json({ jsonrpc: "2.0", id: rpc.id ?? null, result });
  } catch (error) {
    const code = typeof (error as { rpcCode?: unknown }).rpcCode === "number" ? (error as { rpcCode: number }).rpcCode : -32000;
    response.json(rpcError(rpc.id ?? null, code, errorMessage(error)));
  }
}

async function callTool(name: string, args: Record<string, unknown>, services: { store: JsonWorkflowStore; bridge: CodexBridgeService; designer: LoopDesignerService }) {
  if (name === "loop_list") {
    const data = await services.store.getData();
    return toolResult(data.workflows.map((workflow) => ({ id: workflow.id, name: workflow.name, revision: workflow.revision, lifecycle: workflow.lifecycle, status: workflow.status, updatedAt: workflow.updatedAt })));
  }
  if (name === "loop_capabilities") return toolResult(await services.bridge.listTaskCapabilities?.() ?? { items: [], source: "codex", warnings: ["Capability inventory unavailable"] });
  if (name === "loop_create_draft") {
    const draft = createBlankWorkflow();
    if (typeof args.name === "string" && args.name.trim()) draft.name = args.name.trim().slice(0, 160);
    if (typeof args.objective === "string") draft.mainTask = args.objective.trim().slice(0, 12_000);
    const created = await services.store.addWorkflow(draft);
    return toolResult({ workflow: created, deepLink: loopDeepLink(created.id), originThreadId: typeof args.originThreadId === "string" ? args.originThreadId : undefined });
  }
  const id = stringArgument(args, "id", false);
  if (name === "loop_get") return toolResult(await services.store.getWorkflow(id));
  if (name === "loop_validate") {
    const workflow = await services.store.getWorkflow(id);
    return toolResult({ id, revision: workflow.revision, issues: workflow.validationIssues });
  }
  if (name === "loop_designer_message") {
    const message = stringArgument(args, "message", false);
    const workflow = await services.designer.sendMessage(id, message);
    return toolResult({ workflow, deepLink: loopDeepLink(id) });
  }
  if (name === "loop_patch_draft") {
    const baseRevision = numberArgument(args, "baseRevision");
    const definition = args.definition as WorkflowDefinition;
    const workflow = await services.store.applyDefinitionMutation(id, definition, { baseRevision, actor: "mcp", rationale: stringArgument(args, "rationale", false) });
    return toolResult({ workflow, deepLink: loopDeepLink(id) });
  }
  if (name === "loop_publish") return toolResult({ workflow: await services.store.saveWorkflow(id), deepLink: loopDeepLink(id) });
  if (name === "loop_start") return toolResult(await services.bridge.startWorkflow(id));
  if (name === "loop_pause") return toolResult(await services.bridge.pauseWorkflow(id));
  if (name === "loop_resume") return toolResult(await services.bridge.resumeWorkflow(id));
  if (name === "loop_stop") return toolResult(await services.bridge.stopWorkflow(id));
  if (name === "loop_gate_decision") {
    if (!services.bridge.resolveGate) throw new Error("This Codex bridge cannot resolve approval gates");
    const decision = stringArgument(args, "decision", false);
    if (decision !== "approve" && decision !== "decline") throw Object.assign(new Error("decision must be approve or decline"), { rpcCode: -32602 });
    return toolResult(await services.bridge.resolveGate(id, stringArgument(args, "nodeId", false), decision));
  }
  throw Object.assign(new Error(`Unknown Loop tool ${name}`), { rpcCode: -32602 });
}

function mcpAuthorized(request: Request): boolean {
  const expected = process.env.CODEX_LOOP_MCP_TOKEN?.trim();
  if (expected) return request.get("authorization") === `Bearer ${expected}`;
  const address = request.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function loopDeepLink(id: string): string {
  return `${(process.env.CODEX_LOOP_PUBLIC_URL ?? "http://127.0.0.1:4317").replace(/\/$/, "")}/loop/${encodeURIComponent(id)}`;
}

function toolResult(value: unknown) { return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value }; }
function toolError(message: string, code: number) { return { content: [{ type: "text", text: message }], structuredContent: { error: message, code }, isError: true }; }
function rpcError(id: JsonRpcRequest["id"], code: number, message: string) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function stringArgument(args: Record<string, unknown>, key: string, optional: boolean): string { const value = args[key]; if (typeof value === "string" && value.trim()) return value.trim(); if (optional) return ""; throw Object.assign(new Error(`${key} is required`), { rpcCode: -32602 }); }
function numberArgument(args: Record<string, unknown>, key: string): number { const value = args[key]; if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value; throw Object.assign(new Error(`${key} must be a non-negative integer`), { rpcCode: -32602 }); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Unknown Codex Loop MCP error"; }
