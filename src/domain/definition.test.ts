import { describe, expect, it } from "vitest";
import { createBlankWorkflow, createGeneratedWorkflow } from "../data/seed.js";
import { createWorkflowMutation, validateWorkflowDefinition, workflowDefinition } from "./definition.js";

describe("versioned Loop definitions", () => {
  it("captures immutable before and after snapshots", () => {
    const workflow = createGeneratedWorkflow("Keep revision history reproducible");
    const next = workflowDefinition(workflow);
    next.name = "Revised Loop";
    const mutation = createWorkflowMutation(workflow, next, { baseRevision: 0, actor: "designer", rationale: "Clarify the name" });

    next.name = "Changed after mutation";
    expect(mutation.before.name).toBe(workflow.name);
    expect(mutation.after.name).toBe("Revised Loop");
    expect(mutation.revision).toBe(1);
  });

  it("reports structural, orchestration, budget, and setup problems", () => {
    const workflow = createBlankWorkflow();
    const definition = workflowDefinition(workflow);
    definition.nodes = [{
      id: "loop-node", threadId: "loop-thread", name: "Repeat", role: "custom", task: "Try until done", definitionOfDone: "",
      configuredModel: "Terra", effectiveModel: "Terra", reasoningEffort: "medium", connectors: [], readableContextBlockIds: [],
      retryPolicy: { maxAttempts: 1, upgradeModelTo: "Sol" }, status: "idle", attempt: 0, progress: 0, position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, kind: "loop",
    }];
    definition.budgets.maximumConcurrentAgents = 4;
    definition.budgets.maximumTotalAgents = 2;
    definition.capabilityBindings.push({ id: "github", kind: "cli", name: "GitHub CLI", status: "setup-required", requiredByNodeIds: ["loop-node"] });
    definition.secretRequirements.push({ id: "deploy-token", key: "DEPLOY_TOKEN", description: "Deployment token", status: "required", requiredByNodeIds: ["loop-node"] });

    const codes = validateWorkflowDefinition(definition).map((issue) => issue.code);
    expect(codes).toEqual(expect.arrayContaining([
      "missing-objective", "invalid-agent-budget", "missing-definition-of-done", "missing-stop-condition", "capability-setup-required", "secret-setup-required",
    ]));
  });
});
