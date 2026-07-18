import { describe, expect, it } from "vitest";
import type { AgentNode } from "../../domain/types";
import { normalizeAgentModel } from "../../domain/models";
import { celestialVisualFor, defaultReasoningEffort, effortLabel } from "./celestial";

const agent = (patch: Partial<AgentNode>): AgentNode => ({
  id: "agent",
  threadId: "thread",
  name: "Agent",
  role: "custom",
  task: "Do the work",
  definitionOfDone: "The work is verified",
  configuredModel: "Terra",
  effectiveModel: "Terra",
  connectors: [],
  readableContextBlockIds: [],
  retryPolicy: { maxAttempts: 2, upgradeModelTo: "Sol" },
  status: "idle",
  attempt: 0,
  progress: 0,
  position: { x: 0, y: 0 },
  size: { width: 116, height: 124 },
  ...patch,
  kind: patch.kind ?? "agent",
});

describe("celestial agent visuals", () => {
  it("maps explicit Sol, Terra, and Luna model names", () => {
    expect(celestialVisualFor(agent({ effectiveModel: "Sol" })).body).toBe("sol");
    expect(celestialVisualFor(agent({ effectiveModel: "Terra" })).body).toBe("terra");
    expect(celestialVisualFor(agent({ effectiveModel: "Luna" })).body).toBe("luna");
  });

  it("normalizes legacy model records before choosing a visual", () => {
    expect(normalizeAgentModel("gpt-5.2-codex", "implementer")).toBe("Sol");
    expect(normalizeAgentModel("gpt-5.2-codex", "tester")).toBe("Terra");
    expect(normalizeAgentModel("gpt-5.2-codex", "investigator")).toBe("Luna");
  });

  it("formats effort defaults and labels", () => {
    expect(defaultReasoningEffort("reviewer")).toBe("high");
    expect(defaultReasoningEffort("investigator")).toBe("low");
    expect(effortLabel("xhigh")).toBe("Extra high");
  });
});
