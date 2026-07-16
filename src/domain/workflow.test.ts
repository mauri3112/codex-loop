import { describe, expect, it } from "vitest";
import { createGeneratedWorkflow } from "../data/seed";
import { removeAgentNode } from "./workflow";

describe("removeAgentNode", () => {
  it("removes the agent and its dependent workflow records", () => {
    const workflow = createGeneratedWorkflow("Delete a node safely", { id: "delete-node-test" });
    const removed = workflow.nodes[2];
    const untouchedEvent = {
      id: "event-1",
      sequence: 1,
      runId: "run-1",
      kind: "agent" as const,
      type: "agent.completed",
      actor: removed.name,
      message: "Historical evidence remains available.",
      timestamp: workflow.createdAt,
      logicalTime: 1,
      nodeId: removed.id,
    };
    const withHistory = { ...workflow, events: [untouchedEvent] };

    const result = removeAgentNode(withHistory, removed.id);

    expect(result.nodes).not.toContainEqual(expect.objectContaining({ id: removed.id }));
    expect(result.edges.every((edge) => edge.source !== removed.id && edge.target !== removed.id)).toBe(true);
    expect(result.threads).not.toContainEqual(expect.objectContaining({ nodeId: removed.id }));
    expect(result.contextBlocks.every((block) => !block.allowedAgentNodeIds.includes(removed.id))).toBe(true);
    expect(result.observers[0].coveredNodeIds).toEqual(result.nodes.map((node) => node.id));
    expect(result.events).toEqual([untouchedEvent]);
  });

  it("returns the original workflow when the node does not exist", () => {
    const workflow = createGeneratedWorkflow("Keep unknown nodes unchanged", { id: "delete-node-noop" });

    expect(removeAgentNode(workflow, "missing-node")).toBe(workflow);
  });
});
