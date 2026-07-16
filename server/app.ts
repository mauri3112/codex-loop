import { existsSync } from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { Workflow } from "../src/domain/types.js";
import { createBlankWorkflow, createGeneratedWorkflow } from "../src/data/seed.js";
import { JsonWorkflowStore, WorkflowNotFoundError } from "./store.js";
import { CodexBridge, type CodexBridgeService } from "./codex-bridge.js";

const generateSchema = z.object({ task: z.string().trim().min(1).max(12_000) });
const instructionSchema = z.object({ instruction: z.string().trim().min(1).max(12_000) });
const approvalSchema = z.object({ decision: z.enum(["accept", "decline"]) });
const runActionSchema = z.enum(["start", "pause", "resume", "stop", "reset"]);
const runConfigurationSchema = z.object({
  mode: z.enum(["single", "scheduled", "webhook"]),
  schedule: z.object({
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).min(1).max(24),
    timezone: z.string().trim().min(1).max(80),
  }),
  webhook: z.object({
    token: z.string().regex(/^[a-zA-Z0-9_-]{12,128}$/),
    parameters: z.array(z.object({ id: z.string().min(1).max(128), key: z.string().trim().min(1).max(128), defaultValue: z.string().max(2_000) })).max(30),
  }),
});
const triggerValuesSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({});

const workflowSchema = z.custom<Workflow>((value) => {
  if (!value || typeof value !== "object") return false;
  const workflow = value as Partial<Workflow>;
  return Boolean(
    typeof workflow.id === "string" &&
      workflow.id.length > 0 &&
      typeof workflow.name === "string" &&
      typeof workflow.mainTask === "string" &&
      Array.isArray(workflow.nodes) &&
      Array.isArray(workflow.edges) &&
      Array.isArray(workflow.observers) &&
      Array.isArray(workflow.contextBlocks) &&
      Array.isArray(workflow.threads) &&
      Array.isArray(workflow.runs) &&
      Array.isArray(workflow.events),
  );
}, "Invalid workflow payload");

function asyncRoute(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown>,
) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response, next).catch(next);
  };
}

export function createApp(store = new JsonWorkflowStore(), bridge: CodexBridgeService = new CodexBridge(store)) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get("/api/bridge/status", (_request, response) => {
    response.json(bridge.status());
  });

  app.post(
    "/api/bridge/connect",
    asyncRoute(async (_request, response) => {
      response.json(await bridge.connect());
    }),
  );

  app.put(
    "/api/workflows/:id/run-configuration",
    asyncRoute(async (request, response) => {
      const runConfiguration = runConfigurationSchema.parse(request.body);
      response.json(await store.mutateWorkflow(String(request.params.id), (workflow) => {
        workflow.runConfiguration = runConfiguration;
      }));
    }),
  );

  app.get(
    "/api/data",
    asyncRoute(async (_request, response) => {
      response.json(await store.getData());
    }),
  );

  app.get(
    "/api/workflows/:id",
    asyncRoute(async (request, response) => {
      response.json(await store.getWorkflow(String(request.params.id)));
    }),
  );

  app.post(
    "/api/workflows/generate",
    asyncRoute(async (request, response) => {
      const input = generateSchema.parse(request.body);
      const workflow = await store.addWorkflow(createGeneratedWorkflow(input.task));
      response.status(201).json(workflow);
    }),
  );

  const triggerWorkflow = async (request: Request, response: Response) => {
    const token = String(request.params.token);
    const { workflows } = await store.getData();
    const workflow = workflows.find((candidate) => candidate.runConfiguration.mode === "webhook" && candidate.runConfiguration.webhook.token === token);
    if (!workflow) {
      response.status(404).json({ error: "Trigger not found" });
      return;
    }
    if (["running", "paused"].includes(workflow.status)) {
      response.status(409).json({ error: "Workflow is already running" });
      return;
    }
    const supplied = request.method === "GET"
      ? triggerValuesSchema.parse(Object.fromEntries(Object.entries(request.query).map(([key, value]) => [key, String(value)])))
      : triggerValuesSchema.parse(request.body ?? {});
    const defaults = Object.fromEntries(workflow.runConfiguration.webhook.parameters.filter((parameter) => parameter.key).map((parameter) => [parameter.key, parameter.defaultValue]));
    response.status(202).json(await bridge.startWorkflow(workflow.id, { source: "webhook", input: { ...defaults, ...supplied } }));
  };
  app.get("/api/triggers/:token", asyncRoute(triggerWorkflow));
  app.post("/api/triggers/:token", asyncRoute(triggerWorkflow));

  app.post(
    "/api/workflows",
    asyncRoute(async (_request, response) => {
      const workflow = await store.addWorkflow(createBlankWorkflow());
      response.status(201).json(workflow);
    }),
  );

  app.put(
    "/api/workflows/:id",
    asyncRoute(async (request, response) => {
      const workflow = workflowSchema.parse(request.body);
      const workflowId = String(request.params.id);
      if (workflow.id !== workflowId) {
        response.status(400).json({ error: "Workflow id does not match the route" });
        return;
      }
      response.json(await store.updateWorkflow(workflowId, workflow));
    }),
  );

  app.post(
    "/api/workflows/:id/save",
    asyncRoute(async (request, response) => {
      response.json(await store.saveWorkflow(String(request.params.id)));
    }),
  );

  app.post(
    "/api/workflows/:id/run/:action",
    asyncRoute(async (request, response) => {
      const action = runActionSchema.parse(request.params.action);
      const workflowId = String(request.params.id);
      const handlers = {
        start: () => bridge.startWorkflow(workflowId),
        pause: () => bridge.pauseWorkflow(workflowId),
        resume: () => bridge.resumeWorkflow(workflowId),
        stop: () => bridge.stopWorkflow(workflowId),
        reset: () => bridge.resetWorkflow(workflowId),
      };
      response.status(action === "start" ? 202 : 200).json(await handlers[action]());
    }),
  );

  app.post(
    "/api/workflows/:id/threads/:threadId/turn",
    asyncRoute(async (request, response) => {
      const { instruction } = instructionSchema.parse(request.body);
      response.status(202).json(await bridge.sendInstruction(String(request.params.id), String(request.params.threadId), instruction));
    }),
  );

  app.post(
    "/api/workflows/:id/threads/:threadId/stop",
    asyncRoute(async (request, response) => {
      response.json(await bridge.stopThread(String(request.params.id), String(request.params.threadId)));
    }),
  );

  app.post(
    "/api/workflows/:id/threads/:threadId/approval",
    asyncRoute(async (request, response) => {
      const { decision } = approvalSchema.parse(request.body);
      response.json(await bridge.resolveApproval(String(request.params.id), String(request.params.threadId), decision));
    }),
  );

  const distDirectory = path.resolve(process.cwd(), "dist");
  const indexFile = path.join(distDirectory, "index.html");
  if (existsSync(indexFile)) {
    app.use(express.static(distDirectory));
    app.use((request, response, next) => {
      if (request.method !== "GET" || request.path.startsWith("/api/")) {
        next();
        return;
      }
      response.sendFile(indexFile);
    });
  }

  app.use((_request, response) => {
    response.status(404).json({ error: "Not found" });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof WorkflowNotFoundError) {
      response.status(404).json({ error: error.message });
      return;
    }
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: "Invalid request", issues: error.issues });
      return;
    }
    const message = error instanceof Error ? error.message : "Unexpected server error";
    console.error(error);
    response.status(500).json({ error: message });
  });

  return app;
}
