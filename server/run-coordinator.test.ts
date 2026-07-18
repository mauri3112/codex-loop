import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGeneratedWorkflow } from "../src/data/seed.js";
import type { RunInvocation } from "./codex-bridge.js";
import { isScheduleDue, RunCoordinator } from "./run-coordinator.js";
import { JsonWorkflowStore } from "./store.js";

describe("scheduled workflow runs", () => {
  let directory = "";

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("matches configured local days and times without firing twice in the same minute", () => {
    const workflow = createGeneratedWorkflow("Run on a schedule", { saved: true });
    workflow.runConfiguration = {
      ...workflow.runConfiguration,
      mode: "scheduled",
      schedule: { days: [4], times: ["09:30"], timezone: "Europe/Berlin" },
    };
    const now = new Date("2026-07-16T07:30:20.000Z");
    expect(isScheduleDue(workflow, now)).toBe(true);
    workflow.runs.push({ id: "scheduled-1", source: "schedule", status: "completed", step: 1, startedAt: "2026-07-16T07:30:01.000Z" });
    expect(isScheduleDue(workflow, now)).toBe(false);
  });

  it("starts due workflows through the shared bridge with schedule provenance", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codex-loop-schedule-"));
    const store = new JsonWorkflowStore(path.join(directory, "data.json"));
    const workflow = createGeneratedWorkflow("Run through the coordinator", { saved: true });
    workflow.runConfiguration = {
      ...workflow.runConfiguration,
      mode: "scheduled",
      schedule: { days: [4], times: ["09:30"], timezone: "Europe/Berlin" },
    };
    await store.addWorkflow(workflow);
    const starts: Array<{ id: string; invocation?: RunInvocation }> = [];
    const coordinator = new RunCoordinator(store, {
      startWorkflow: async (id, invocation) => {
        starts.push({ id, invocation });
        return store.getWorkflow(id);
      },
    });

    await coordinator.tick(new Date("2026-07-16T07:30:20.000Z"));
    expect(starts).toEqual([{ id: workflow.id, invocation: { source: "schedule" } }]);
  });
});
