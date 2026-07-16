import { describe, expect, it } from "vitest";
import { createGeneratedWorkflow } from "../data/seed";
import { nextRunContextForAgent, nextRunRecipientsForContext } from "./context";

describe("next-run context", () => {
  it("filters context using the IDs that will be copied into the agent's next attempt", () => {
    const workflow = createGeneratedWorkflow("Verify context routing");
    const agent = workflow.nodes[0];
    const expectedIds = new Set(agent.readableContextBlockIds);

    expect(nextRunContextForAgent(workflow.contextBlocks, agent).map((block) => block.id))
      .toEqual(workflow.contextBlocks.filter((block) => expectedIds.has(block.id)).map((block) => block.id));
  });

  it("keeps the full overview when no agent is selected", () => {
    const workflow = createGeneratedWorkflow("Verify context routing");

    expect(nextRunContextForAgent(workflow.contextBlocks)).toEqual(workflow.contextBlocks);
  });

  it("reports recipients from each agent's actual next-run context", () => {
    const workflow = createGeneratedWorkflow("Verify context routing");
    const context = workflow.contextBlocks[0];

    expect(nextRunRecipientsForContext(context.id, workflow.nodes).map((agent) => agent.id))
      .toEqual(workflow.nodes.filter((agent) => agent.readableContextBlockIds.includes(context.id)).map((agent) => agent.id));
  });
});
