import { describe, expect, it } from "vitest";
import { createGeneratedWorkflow } from "../data/seed";
import { applySimulationStep, pauseWorkflow, resetWorkflow, resumeWorkflow, SIMULATION_STEPS, startWorkflow, stopWorkflow } from "./simulation";

describe("Codex Loop deterministic simulation", () => {
  it("runs parallel investigation, failure, Observer retry, model upgrade, verification, and review", () => {
    let workflow = startWorkflow(createGeneratedWorkflow("Fix the cache race"));
    for (let step = 0; step < SIMULATION_STEPS; step += 1) workflow = applySimulationStep(workflow);
    const types = workflow.events.map((event) => event.type);
    const investigatorStarts = workflow.events.filter((event) => event.type === "node.started" && workflow.nodes.find((node) => node.id === event.nodeId)?.role === "investigator");
    expect(investigatorStarts).toHaveLength(2);
    expect(investigatorStarts[0].logicalTime).toBe(investigatorStarts[1].logicalTime);
    expect(types.indexOf("node.failed")).toBeLessThan(types.indexOf("observer.failure-detected"));
    expect(types.indexOf("observer.failure-detected")).toBeLessThan(types.indexOf("model.upgraded"));
    expect(types.at(-1)).toBe("workflow.completed");
    expect(workflow.status).toBe("completed");
    expect(workflow.nodes.every((node) => node.status === "completed")).toBe(true);
    const implementer = workflow.nodes.find((node) => node.role === "implementer")!;
    expect(implementer.attempt).toBe(2);
    expect(implementer.effectiveModel).toBe(implementer.retryPolicy.upgradeModelTo);
    expect(workflow.threads.find((thread) => thread.id === implementer.threadId)?.attempts).toHaveLength(2);
  });

  it("pauses without advancing, resumes, stops, and resets topology", () => {
    const source = createGeneratedWorkflow("Refactor safely");
    let workflow = applySimulationStep(startWorkflow(source));
    workflow = pauseWorkflow(workflow);
    const pausedStep = workflow.runs.at(-1)!.step;
    workflow = applySimulationStep(workflow);
    expect(workflow.runs.at(-1)!.step).toBe(pausedStep);
    workflow = resumeWorkflow(workflow);
    workflow = applySimulationStep(workflow);
    expect(workflow.runs.at(-1)!.step).toBe(pausedStep + 1);
    workflow = stopWorkflow(workflow);
    expect(workflow.status).toBe("stopped");
    const nodeCount = workflow.nodes.length;
    workflow = resetWorkflow(workflow);
    expect(workflow.nodes).toHaveLength(nodeCount);
    expect(workflow.nodes.every((node) => node.status === "idle")).toBe(true);
  });

  it("delivers only explicitly granted context to the test thread", () => {
    let workflow = startWorkflow(createGeneratedWorkflow("Fix a race"));
    for (let step = 0; step < 16; step += 1) workflow = applySimulationStep(workflow);
    const tester = workflow.nodes.find((node) => node.role === "tester")!;
    const titles = workflow.contextBlocks.filter((block) => tester.readableContextBlockIds.includes(block.id)).map((block) => block.title);
    expect(titles).toContain("Acceptance criteria");
    expect(titles).toContain("Changed files");
    expect(titles).not.toContain("Likely race condition");
    expect(workflow.events.filter((event) => event.type === "context.permission-granted" && event.nodeId === tester.id).length).toBeGreaterThanOrEqual(2);
  });
});
