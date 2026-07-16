import { describe, expect, it } from "vitest";
import { createGeneratedWorkflow } from "../data/seed";
import { AGENT_MODELS, EFFORT_LEVELS } from "./models";
import { COMPACT_AGENT_SIZE, normalizeWorkflow } from "./normalize";
import type { Workflow } from "./types";

describe("workflow normalization", () => {
  it("limits runtime choices to three models and five effort levels", () => {
    expect(AGENT_MODELS).toEqual(["Sol", "Terra", "Luna"]);
    expect(EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("migrates legacy model strings and guarantees one enclosing supervisor", () => {
    const workflow = createGeneratedWorkflow("Verify the loop UI");
    workflow.events.push({ id: "legacy-model", sequence: 1, runId: "run", kind: "model", type: "model.started", actor: "Agent", message: "Started with gpt-5.2-codex", timestamp: new Date().toISOString(), logicalTime: 1, nodeId: workflow.nodes[0].id });
    const legacy = JSON.parse(JSON.stringify(workflow)) as { defaultModel: string; nodes: Array<Record<string, unknown>>; observers: unknown[]; environmentVariables?: unknown; attentionRequests?: unknown; interventions?: unknown };
    legacy.defaultModel = "gpt-5.2-codex";
    legacy.nodes[0].configuredModel = "gpt-5.2-codex";
    legacy.nodes[0].effectiveModel = "gpt-5.2-codex";
    legacy.observers = [];
    delete legacy.environmentVariables;
    delete legacy.attentionRequests;
    delete legacy.interventions;

    const normalized = normalizeWorkflow(legacy as unknown as Workflow);
    expect(AGENT_MODELS).toContain(normalized.defaultModel);
    expect(normalized.nodes.every((node) => AGENT_MODELS.includes(node.configuredModel))).toBe(true);
    expect(normalized.nodes.every((node) => node.size.width === COMPACT_AGENT_SIZE.width && node.size.height === COMPACT_AGENT_SIZE.height)).toBe(true);
    expect(normalized.observers).toHaveLength(1);
    expect(normalized.observers[0].name).toBe("Loop supervisor");
    expect(normalized.observers[0].coveredNodeIds).toEqual(normalized.nodes.map((node) => node.id));
    expect(normalized.events[0].message).toBe("Started with Luna");
    expect(normalized.environmentVariables).toEqual([]);
    expect(normalized.attentionRequests).toEqual([]);
    expect(normalized.interventions).toEqual([]);
  });
});
