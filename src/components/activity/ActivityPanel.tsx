import { useEffect, useMemo, useRef, useState } from "react";
import { Boxes, ChevronDown, ChevronUp, CircleAlert, FileCode2, ListFilter, Maximize2, Sparkles, TerminalSquare } from "lucide-react";
import { nextRunContextForAgent, nextRunRecipientsForContext } from "../../domain/context";
import type { AgentNode, AuditEvent, ContextBlock } from "../../domain/types";
import { celestialVisualFor } from "../canvas/celestial";
import "./activity.css";

const FILTERS = ["all", "agent", "tool", "context", "observer", "errors"] as const;

interface ActivityPanelProps {
  events: AuditEvent[];
  contexts: ContextBlock[];
  agents: AgentNode[];
  open: boolean;
  onToggle: () => void;
  onSelectNode: (id: string) => void;
  onSelectContext: (id: string) => void;
}

export function ActivityPanel({ events, contexts, agents, open, onToggle, onSelectNode, onSelectContext }: ActivityPanelProps) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [contextAgentId, setContextAgentId] = useState("");
  const [audit, setAudit] = useState(false);
  const [height, setHeight] = useState(() => {
    const stored = Number(globalThis.localStorage?.getItem("codex-loop-activity-height"));
    return Number.isFinite(stored) && stored >= 160 ? stored : 250;
  });
  const panelRef = useRef<HTMLElement>(null);
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);
  const resizeTo = (nextHeight: number) => {
    const parentHeight = panelRef.current?.parentElement?.clientHeight ?? window.innerHeight;
    const constrained = Math.round(Math.max(160, Math.min(parentHeight - 140, nextHeight)));
    setHeight(constrained);
    globalThis.localStorage?.setItem("codex-loop-activity-height", String(constrained));
  };
  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    const move = (pointer: PointerEvent) => resizeTo(startHeight + startY - pointer.clientY);
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      dragCleanup.current = null;
    };
    dragCleanup.current?.();
    dragCleanup.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };
  const visible = useMemo(() => events.filter((event) => filter === "all" || (filter === "errors" ? /fail|error/i.test(`${event.type} ${event.message}`) : event.kind === filter)), [events, filter]);
  const latest = events.at(-1);
  const contextAgent = agents.find((agent) => agent.id === contextAgentId);
  const visibleContexts = useMemo(() => nextRunContextForAgent(contexts, contextAgent), [contexts, contextAgent]);
  const contextTokens = visibleContexts.reduce((sum, context) => sum + context.estimatedTokens, 0);
  return (
    <section ref={panelRef} className={`activity-panel ${open ? "open" : "collapsed"}`} aria-label="Workflow activity" style={open ? { height } : undefined}>
      {open ? <div className="activity-resize-handle" role="separator" aria-label="Resize activity and context panel" aria-orientation="horizontal" tabIndex={0} onPointerDown={beginResize} onKeyDown={(event) => { if (event.key === "ArrowUp") { event.preventDefault(); resizeTo(height + 24); } else if (event.key === "ArrowDown") { event.preventDefault(); resizeTo(height - 24); } }}><span /></div> : null}
      <header className="activity-header">
        <div className="activity-header-half">
          <button className="activity-title" onClick={onToggle} aria-expanded={open}>
            <TerminalSquare size={15} /> Activity
            <span className="activity-count">{events.length}</span>
            {!open && latest && <span className="activity-latest">{latest.message}</span>}
            {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>
          {open ? <div className="activity-actions"><button className={audit ? "active" : ""} onClick={() => setAudit((value) => !value)}><Maximize2 size={13} /> Audit view</button></div> : null}
        </div>
        <div className="context-header-half">
          <Boxes size={14} />
          <span>Next-run context</span>
          <label className="context-agent-filter">
            <span className="context-agent-filter-label">Node</span>
            <select aria-label="Filter next-run context by node" value={contextAgent?.id ?? ""} onChange={(event) => setContextAgentId(event.target.value)}>
              <option value="">All nodes</option>
              {agents.map((agent, index) => <option key={agent.id} value={agent.id}>Node {index + 1} · {agent.name}</option>)}
            </select>
          </label>
          <b>{visibleContexts.length} · {contextTokens.toLocaleString()} tokens</b>
        </div>
      </header>
      {open && (
        <div className="workflow-feed-body">
          <div className={`activity-body ${audit ? "audit" : ""}`}>
            <aside className="activity-filters" aria-label="Activity filters">
              <span><ListFilter size={13} /> Filters</span>
              {FILTERS.map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item === "all" ? "All activity" : item[0].toUpperCase() + item.slice(1)}</button>)}
            </aside>
            <div className="activity-events" role="log" aria-live="polite">
              {visible.length === 0 && <div className="activity-empty">Activity will appear when the loop starts.</div>}
              {visible.map((event) => (
                <button key={event.id} className={`event-row kind-${event.kind}`} onClick={() => event.nodeId && onSelectNode(event.nodeId)} disabled={!event.nodeId}>
                  <span className="event-icon">{event.kind === "observer" || /fail/.test(event.type) ? <CircleAlert size={14} /> : event.kind === "context" ? <Sparkles size={14} /> : event.kind === "file" ? <FileCode2 size={14} /> : <span className="event-dot" />}</span>
                  <time>{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
                  <span className="event-copy"><strong>{event.actor}</strong><span>{event.message}</span></span>
                  {audit ? <span className="event-type">{event.type}</span> : null}
                  {audit ? <span className="event-seq">#{event.sequence}</span> : null}
                </button>
              ))}
            </div>
          </div>
          <section className="context-access" aria-label={contextAgent ? `Context for ${contextAgent.name}'s next run` : "Context access at turn start"}>
            <div className="context-access-list">
              {visibleContexts.length === 0 ? <div className="context-access-empty">No context is queued for {contextAgent?.name ?? "the next run"}.</div> : null}
              {visibleContexts.map((context) => {
                const recipients = new Set(nextRunRecipientsForContext(context.id, agents).map((agent) => agent.id));
                const allowed = agents.flatMap((agent, index) => recipients.has(agent.id) ? [{ agent, order: index + 1 }] : []);
                return (
                  <button type="button" className="context-access-row" key={context.id} onClick={() => onSelectContext(context.id)}>
                    <span className="context-access-copy"><strong>{context.title}</strong><span>{context.summary}</span><small>{context.estimatedTokens.toLocaleString()} tokens · {allowed.length} nodes informed</small></span>
                    <span className="context-access-models" aria-label={`Available to ${allowed.length} nodes`}>
                      {allowed.map(({ agent, order }) => {
                        const visual = celestialVisualFor(agent);
                        return <span className={`context-model context-model-${visual.body}`} key={agent.id}><b>{order}</b>{visual.label}</span>;
                      })}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
