import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBlankWorkflow } from "../src/data/seed.js";
import { CodexAppServerClient } from "./codex-app-server.js";
import { CodexLoopDesigner, validateStrictObjectSchemas } from "./loop-designer.js";
import { JsonWorkflowStore } from "./store.js";

const fixture = path.resolve(process.cwd(), "server/fixtures/fake-app-server.mjs");

describe("persistent Loop Designer", () => {
  let directory = "";
  let designer: CodexLoopDesigner | undefined;

  afterEach(async () => {
    await designer?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("rejects response schemas whose object properties are not all required", () => {
    expect(() => validateStrictObjectSchemas({
      type: "object",
      additionalProperties: false,
      properties: { requiredValue: { type: "string" }, missingValue: { type: "string" } },
      required: ["requiredValue"],
    })).toThrow("required is missing missingValue");
  });

  it("compiles a schema-constrained proposal into a versioned graph", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codex-loop-designer-"));
    const store = new JsonWorkflowStore(path.join(directory, "data.json"));
    const draft = await store.addWorkflow(createBlankWorkflow());
    const proposal = {
      response: "I created a bounded implementation and verification Loop.",
      name: "Ship and verify",
      objective: "Implement the requested change and prove it works.",
      assumptions: ["The current repository is the target."],
      questions: [],
      steps: [
        { key: "implement", name: "Implement", kind: "agent", role: "implementer", task: "Implement the scoped change.", definitionOfDone: "The change builds.", model: "Terra", reasoningEffort: "high", dependsOn: [], capabilities: ["cli:github"] },
        { key: "verify", name: "Verify", kind: "verify", role: "tester", task: "Run the relevant verification.", definitionOfDone: "Tests pass with evidence.", model: "Sol", reasoningEffort: "xhigh", dependsOn: ["implement"], capabilities: [], orchestration: { verificationRubric: "Build and tests must pass." } },
      ],
      secretRequirements: [],
      budgets: { maximumConcurrentAgents: 2, maximumTotalAgents: 6, maximumIterations: 3, maximumWallClockMinutes: 30, maximumNoProgressRounds: 2 },
    };
    const client = new CodexAppServerClient({ command: process.execPath, args: [fixture], env: { FAKE_AGENT_OUTPUT: JSON.stringify(proposal) } });
    designer = new CodexLoopDesigner(store, {
      listTaskCapabilities: async () => ({
        source: "codex",
        items: [{ id: "cli:github", kind: "cli", label: "GitHub CLI", description: "Authenticated GitHub CLI", invocation: "gh", available: true, authStatus: "verified" }],
      }),
    }, client);

    const updated = await designer.sendMessage(draft.id, "Create a Loop to implement and verify this change");
    expect(updated.revision).toBe(1);
    expect(updated.nodes.map((node) => node.kind)).toEqual(["agent", "verify"]);
    expect(updated.edges).toHaveLength(1);
    expect(updated.capabilityBindings[0]).toMatchObject({ id: "cli:github", status: "available", authStatus: "verified" });
    expect(updated.designer.threadId).toMatch(/^native-thread-/);
    expect(updated.designer.state).toBe("idle");
    expect(updated.designer.assumptions).toEqual(proposal.assumptions);
    expect(updated.designer.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(updated.validationIssues.some((issue) => issue.severity === "error")).toBe(false);
  });
});
