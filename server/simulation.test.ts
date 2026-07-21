import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGeneratedWorkflow } from "../src/data/seed.js";
import type { TaskCapabilitiesResponse } from "../src/domain/task-capabilities.js";
import { simulateWorkflow } from "./simulation.js";

const directories: string[] = [];

async function readableWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-loop-simulation-"));
  directories.push(directory);
  return directory;
}

function capabilities(items: TaskCapabilitiesResponse["items"] = []): { listTaskCapabilities: () => Promise<TaskCapabilitiesResponse> } {
  return { listTaskCapabilities: async () => ({ source: "codex", items }) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("read-only workflow simulation", () => {
  it("builds a staged plausible execution without mutating workflow state", async () => {
    const workflow = createGeneratedWorkflow("Add a safe simulation preview");
    workflow.sharedConnectors = [];
    workflow.nodes.forEach((node) => { node.connectors = []; });
    const before = structuredClone(workflow);

    const report = await simulateWorkflow(workflow, capabilities(), { workingDirectory: await readableWorkspace() });

    expect(report.readOnly).toBe(true);
    expect(report.status).toBe("sound");
    expect(report.canRun).toBe(true);
    expect(report.steps).toHaveLength(workflow.nodes.length);
    expect(report.steps.map((step) => step.stage)).toEqual([1, 1, 2, 3, 4]);
    expect(report.steps[0].procedure.join(" ")).toContain("no thread was created");
    expect(report.possibleFinalOutput).toContain("Possible final result");
    expect(workflow).toEqual(before);
  });

  it("blocks only affected procedures when live authentication or a secret is missing", async () => {
    const workflow = createGeneratedWorkflow("Use authenticated repository data");
    workflow.sharedConnectors = [];
    workflow.nodes.forEach((node) => { node.connectors = []; });
    workflow.capabilityBindings = [{
      id: "mcp:repository",
      kind: "mcp",
      name: "Repository MCP",
      status: "available",
      authStatus: "oAuth",
      requiredByNodeIds: [workflow.nodes[0].id],
    }];
    workflow.secretRequirements = [{
      id: "secret-test-token",
      key: "CODEX_LOOP_TEST_MISSING_TOKEN",
      description: "Test-only token",
      status: "bound",
      source: "process-env",
      sourceRef: "CODEX_LOOP_TEST_MISSING_TOKEN",
      requiredByNodeIds: [workflow.nodes[1].id],
    }];
    delete process.env.CODEX_LOOP_TEST_MISSING_TOKEN;

    const report = await simulateWorkflow(workflow, capabilities([{
      id: "mcp:repository",
      kind: "mcp",
      label: "Repository MCP",
      description: "Repository access",
      invocation: "Use repository MCP",
      available: false,
      authStatus: "notLoggedIn",
    }]), { workingDirectory: await readableWorkspace() });

    expect(report.status).toBe("blocked");
    expect(report.canRun).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "capability-mcp:repository", status: "fail" }),
      expect.objectContaining({ id: "secret-secret-test-token", status: "fail" }),
    ]));
    expect(report.steps.find((step) => step.nodeId === workflow.nodes[0].id)?.status).toBe("blocked");
    expect(report.steps.find((step) => step.nodeId === workflow.nodes[1].id)?.status).toBe("blocked");
  });

  it("reports dependency cycles and unavailable probes without attempting execution", async () => {
    const workflow = createGeneratedWorkflow("Detect an unsound graph");
    workflow.sharedConnectors = [];
    workflow.nodes.forEach((node) => { node.connectors = []; });
    workflow.edges.push({
      id: "cycle-back",
      source: workflow.nodes.at(-1)!.id,
      target: workflow.nodes[0].id,
      trigger: "source-completed",
      payload: [],
      retries: 0,
      failureBehavior: "block-target",
      approvalRequired: false,
      status: "idle",
    });
    let probeCalls = 0;

    const report = await simulateWorkflow(workflow, {
      listTaskCapabilities: async () => {
        probeCalls += 1;
        throw new Error("Codex inventory offline");
      },
    }, { workingDirectory: await readableWorkspace() });

    expect(probeCalls).toBe(1);
    expect(report.status).toBe("blocked");
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "runtime-inventory", status: "warning" }),
      expect.objectContaining({ id: "graph-cycle", status: "fail" }),
    ]));
    expect(report.steps.some((step) => step.status === "blocked")).toBe(true);
  });
});
