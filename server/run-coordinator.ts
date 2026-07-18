import type { Workflow } from "../src/domain/types.js";
import type { CodexBridgeService } from "./codex-bridge.js";
import { JsonWorkflowStore } from "./store.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface ZonedMinute {
  weekday: number;
  date: string;
  time: string;
}

function zonedMinute(date: Date, timezone: string): ZonedMinute | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
    const weekday = WEEKDAYS.indexOf(value("weekday"));
    if (weekday < 0) return undefined;
    return {
      weekday,
      date: `${value("year")}-${value("month")}-${value("day")}`,
      time: `${value("hour")}:${value("minute")}`,
    };
  } catch {
    return undefined;
  }
}

export function isScheduleDue(workflow: Workflow, now = new Date()): boolean {
  const configuration = workflow.runConfiguration;
  if (workflow.lifecycle !== "published" || configuration.mode !== "scheduled" || ["running", "paused"].includes(workflow.status)) return false;
  const current = zonedMinute(now, configuration.schedule.timezone);
  if (!current || !configuration.schedule.days.includes(current.weekday) || !configuration.schedule.times.includes(current.time)) return false;
  return !workflow.runs.some((run) => {
    if (run.source !== "schedule" || !run.startedAt) return false;
    const previous = zonedMinute(new Date(run.startedAt), configuration.schedule.timezone);
    return previous?.date === current.date && previous.time === current.time;
  });
}

export class RunCoordinator {
  private timer: NodeJS.Timeout | undefined;
  private readonly starting = new Set<string>();

  constructor(
    private readonly store: JsonWorkflowStore,
    private readonly bridge: Pick<CodexBridgeService, "startWorkflow">,
    private readonly intervalMs = 15_000,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(now = new Date()): Promise<void> {
    const { workflows } = await this.store.getData();
    await Promise.all(workflows.filter((workflow) => isScheduleDue(workflow, now)).map(async (workflow) => {
      if (this.starting.has(workflow.id)) return;
      this.starting.add(workflow.id);
      try {
        await this.bridge.startWorkflow(workflow.id, { source: "schedule" });
      } catch (error) {
        console.warn(`[schedule] Could not start ${workflow.id}:`, error instanceof Error ? error.message : error);
      } finally {
        this.starting.delete(workflow.id);
      }
    }));
  }
}
