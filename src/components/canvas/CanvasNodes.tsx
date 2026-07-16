import { memo, type CSSProperties } from "react";
import { Database, Eye, ExternalLink, LockKeyhole } from "lucide-react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { AgentFlowNode, ContextFlowNode, ObserverFlowNode } from "./types";
import { celestialVisualFor, defaultReasoningEffort, effortLabel } from "./celestial";

const statusLabels: Record<string, string> = {
  idle: "Idle",
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  blocked: "Blocked",
  failed: "Failed",
  retrying: "Retrying",
  completed: "Completed",
  stopped: "Stopped",
};

function AgentNodeView({ data, selected }: NodeProps<AgentFlowNode>) {
  const { agent, order } = data;
  const celestial = celestialVisualFor(agent);
  const effort = agent.reasoningEffort ?? defaultReasoningEffort(agent.role);
  const tooltipId = `agent-details-${agent.id}`;
  const tooltipSide = agent.position.x >= 620 ? "is-left" : "is-right";
  const tooltipVertical = agent.position.y >= 280 ? "is-upper" : "is-lower";

  return (
    <article
      className={`loop-node loop-agent loop-agent-${celestial.body} loop-effort-${effort} loop-status-${agent.status}${selected ? " is-selected" : ""}`}
      data-celestial-model={celestial.label}
      tabIndex={0}
      aria-label={`${agent.name}, ${celestial.label}, ${effortLabel(effort)} effort, ${statusLabels[agent.status]}`}
      aria-describedby={tooltipId}
    >
      <Handle className="loop-port loop-port-input" type="target" position={Position.Left} />
      <div className="loop-celestial-orbit" style={{ "--node-progress": `${Math.max(0, Math.min(100, agent.progress)) * 3.6}deg` } as CSSProperties}>
        <span className="loop-node-number" aria-hidden="true">{order}</span>
        <span className="loop-celestial-body">
          <img src={celestial.asset} alt="" draggable={false} />
        </span>
      </div>
      <div className="loop-celestial-caption">
        <strong>{agent.name}</strong>
        <span><i className={`loop-status-dot loop-status-dot-${agent.status}`} aria-hidden="true" />{celestial.label}</span>
      </div>
      <Handle className="loop-port loop-port-output" type="source" position={Position.Right} />

      <aside id={tooltipId} role="tooltip" className={`loop-agent-tooltip ${tooltipSide} ${tooltipVertical} nodrag nopan`}>
        <header>
          <img src={celestial.asset} alt="" />
          <div><strong>{agent.name}</strong><span>Node {order} · {celestial.label} · {statusLabels[agent.status]}</span></div>
          {data.onOpenThread ? (
            <button
              className="loop-node-open"
              type="button"
              aria-label={`Open ${agent.name} thread`}
              title="Open thread"
              onClick={(event) => {
                event.stopPropagation();
                data.onOpenThread?.(agent.threadId);
              }}
            >
              <ExternalLink size={14} aria-hidden="true" />
            </button>
          ) : null}
        </header>
        <dl className="loop-agent-tooltip-meta">
          <div><dt>Effort</dt><dd>{effortLabel(effort)}</dd></div>
          {agent.attempt > 1 ? <div><dt>Attempt</dt><dd>{agent.attempt}</dd></div> : null}
        </dl>
        <section><h4>Task</h4><p>{agent.task || "Add a task in the inspector."}</p></section>
        <section><h4>Definition of done</h4><p>{agent.definitionOfDone || "Add a definition of done in the inspector."}</p></section>
      </aside>
    </article>
  );
}

function ContextNodeView({ data, selected }: NodeProps<ContextFlowNode>) {
  const visibleAgents = data.agents.filter((agent) => data.block.allowedAgentNodeIds.includes(agent.id));
  return (
    <article className={`loop-node loop-context${selected ? " is-selected" : ""}`}>
      <header className="loop-node-header">
        <span className="loop-node-icon loop-context-icon"><Database size={13} aria-hidden="true" /></span>
        <div className="loop-node-heading">
          <strong>{data.block.title}</strong>
          <span>{data.block.category.replaceAll("-", " ")}</span>
        </div>
      </header>
      <p>{data.block.summary}</p>
      <footer className="loop-context-footer">
        <span>{data.block.estimatedTokens.toLocaleString()} tokens</span>
        <span className="loop-access-list" aria-label={`Accessible to ${visibleAgents.length} agents`}>
          <LockKeyhole size={11} aria-hidden="true" />
          {visibleAgents.slice(0, 3).map((agent) => (
            <span className="loop-access-sticker" title={agent.name} key={agent.id}>{agent.name.slice(0, 1)}</span>
          ))}
          {visibleAgents.length > 3 ? <span className="loop-access-more">+{visibleAgents.length - 3}</span> : null}
        </span>
      </footer>
    </article>
  );
}

function ObserverNodeView({ data, selected }: NodeProps<ObserverFlowNode>) {
  const { observer } = data;
  return (
    <section className={`loop-observer loop-observer-${observer.status}${selected ? " is-selected" : ""}`}>
      <header className="loop-observer-header">
        <Eye size={13} aria-hidden="true" />
        <strong>{observer.name}</strong>
        <span className="loop-supervisor-health"><i />{observer.status === "intervening" ? "Intervening" : "Healthy"}</span>
        <span>{observer.coveredNodeIds.length} nodes</span>
      </header>
      <p>{observer.instructions}</p>
      {observer.status === "intervening" ? <span className="loop-observer-alert">Intervening</span> : null}
    </section>
  );
}

export const AgentCanvasNode = memo(AgentNodeView);
export const ContextCanvasNode = memo(ContextNodeView);
export const ObserverCanvasNode = memo(ObserverNodeView);
