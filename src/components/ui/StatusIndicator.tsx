import type { AgentStatus, WorkflowStatus } from "../../domain/types";
import "./ui.css";

export type IndicatorStatus = AgentStatus | WorkflowStatus;

const STATUS_LABELS: Record<IndicatorStatus, string> = {
  idle: "Idle",
  draft: "Draft",
  ready: "Ready",
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  blocked: "Blocked",
  failed: "Failed",
  retrying: "Retrying",
  completed: "Completed",
  stopped: "Stopped",
  paused: "Paused",
};

export interface StatusIndicatorProps {
  status: IndicatorStatus;
  showLabel?: boolean;
  className?: string;
}

export function StatusIndicator({ status, showLabel = false, className = "" }: StatusIndicatorProps) {
  const label = STATUS_LABELS[status];

  return (
    <span className={["status-indicator", className].filter(Boolean).join(" ")} aria-label={`Status: ${label}`}>
      <span className={`status-indicator__dot status-indicator__dot--${status}`} aria-hidden="true" />
      {showLabel ? <span className="status-indicator__label">{label}</span> : null}
    </span>
  );
}
