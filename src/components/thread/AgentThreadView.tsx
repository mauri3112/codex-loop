import { useMemo, useState } from "react";
import { ArrowLeft, Check, ChevronDown, ChevronRight, CircleStop, FileCode2, GitCompareArrows, Play, Send, TerminalSquare } from "lucide-react";
import type { Workflow } from "../../domain/types";
import "./thread.css";

export function AgentThreadView({ workflow, threadId, onBack, onSend, onStop, onResolveApproval }: { workflow: Workflow; threadId: string; onBack: () => void; onSend: (instruction: string) => Promise<void>; onStop: () => Promise<void>; onResolveApproval: (decision: "accept" | "decline") => Promise<void> }) {
  const thread = workflow.threads.find((item) => item.id === threadId);
  const node = workflow.nodes.find((item) => item.threadId === threadId);
  const [instruction, setInstruction] = useState("");
  const [showChanges, setShowChanges] = useState(false);
  const [openTools, setOpenTools] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const received = useMemo(() => workflow.contextBlocks.filter((block) => node?.readableContextBlockIds.includes(block.id) || thread?.attempts.some((attempt) => attempt.receivedContextBlockIds.includes(block.id))), [workflow.contextBlocks, node, thread]);
  if (!thread || !node) return <div className="thread-missing">Thread not found <button onClick={onBack}>Return to Loop</button></div>;

  const addInstruction = async () => {
    const value = instruction.trim();
    if (!value) return;
    setSubmitting(true);
    setError("");
    try { await onSend(value); setInstruction(""); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not send instruction"); } finally { setSubmitting(false); }
  };
  const toggleRun = async () => {
    setSubmitting(true);
    setError("");
    try { if (thread.status === "running") await onStop(); else await onSend("Continue the assigned task from the current state. Verify the result and report the outcome."); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update thread"); } finally { setSubmitting(false); }
  };

  return (
    <main className="agent-thread-view">
      <header className="thread-topbar">
        <button className="thread-back" onClick={onBack}><ArrowLeft size={15} /> Back to Loop</button>
        <div className="thread-title"><strong>{thread.title}</strong><span>{workflow.name}</span></div>
        <div className="thread-top-actions">
          <button onClick={() => setShowChanges(true)} disabled={!thread.fileChanges.length}><GitCompareArrows size={14} /> Review changes</button>
          <button className={thread.status === "running" ? "danger" : ""} onClick={() => void toggleRun()} disabled={submitting}>{thread.status === "running" ? <CircleStop size={14} /> : <Play size={14} />}{thread.status === "running" ? "Stop" : "Continue"}</button>
        </div>
      </header>
      <div className="thread-layout">
        <article className="thread-scroll">
          <section className="thread-brief">
            <div className="thread-assignment"><span className={`thread-status status-${thread.status}`} /> <span>{thread.status}</span><span>Agent thread</span></div>
            <h1>{thread.task}</h1>
            <dl>
              <div><dt>Definition of done</dt><dd>{thread.definitionOfDone}</dd></div>
              <div><dt>Model</dt><dd>{node.configuredModel !== node.effectiveModel ? <><s>{node.configuredModel}</s> <strong>{node.effectiveModel}</strong></> : node.effectiveModel}</dd></div>
              <div><dt>Connectors</dt><dd>{thread.connectors.join(" · ") || "None"}</dd></div>
              <div><dt>Native Codex</dt><dd>{thread.codex?.threadId ? `${thread.codex.threadId.slice(0, 8)} · ${thread.codex.model ?? "default model"}` : "Not connected yet"}</dd></div>
            </dl>
          </section>

          {thread.pendingApproval && <section className="thread-approval"><strong>Codex needs approval</strong><p>{thread.pendingApproval.reason || thread.pendingApproval.command || `Approve this ${thread.pendingApproval.type} request?`}</p><div><button onClick={() => void onResolveApproval("decline")}>Decline</button><button className="approve" onClick={() => void onResolveApproval("accept")}>Approve</button></div></section>}

          <section className="thread-context">
            <h2>Received shared context <span>{received.length}</span></h2>
            {received.length === 0 ? <p className="thread-empty">No shared context was delivered to this thread.</p> : received.map((block) => <div className="received-block" key={block.id}><span>{block.title}</span><p>{block.summary}</p><small>{block.createdBy} · {block.estimatedTokens} tokens</small></div>)}
          </section>

          <section className="thread-timeline">
            {thread.messages.map((item) => <div key={item.id} className={`thread-message role-${item.role}`}><div className="message-author">{item.role === "user" ? "You" : item.role === "assistant" ? thread.title : "Loop"}<time>{new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div><p>{item.content}</p></div>)}
            {thread.attempts.map((attempt) => <div className={`attempt-row attempt-${attempt.status}`} key={attempt.number}><span>{attempt.status === "completed" ? <Check size={13} /> : <span className="attempt-dot" />}</span><div><strong>Attempt {attempt.number}</strong><p>{attempt.summary}</p></div><span className="attempt-model">{attempt.model}</span></div>)}
            {thread.toolCalls.length > 0 && <div className="thread-tools"><button onClick={() => setOpenTools((value) => !value)}>{openTools ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<TerminalSquare size={14} /> Tool calls <span>{thread.toolCalls.length}</span></button>{openTools && thread.toolCalls.map((tool) => <div className={`tool-record tool-${tool.status}`} key={tool.id}><header><strong>{tool.name}</strong><span>{tool.status}</span></header><code>{tool.command}</code><pre>{tool.output}</pre></div>)}</div>}
            {thread.finalOutput && <div className="final-output"><span><Check size={14} /></span><div><strong>Final output</strong><p>{thread.finalOutput}</p></div></div>}
          </section>
          <div className="thread-composer-wrap">
            <div className="thread-composer">
              <textarea aria-label="Add instructions" placeholder="Add instructions or answer a question…" value={instruction} onChange={(event) => setInstruction(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); void addInstruction(); } }} />
              <button onClick={() => void addInstruction()} disabled={!instruction.trim() || submitting} aria-label="Send instruction"><Send size={15} /></button>
            </div>
            {error ? <span className="thread-error">{error}</span> : <span>Instructions are sent to the native Codex thread.</span>}
          </div>
        </article>
        {showChanges && (
          <aside className="changes-panel">
            <header><div><strong>Review changes</strong><span>{thread.fileChanges.length} files</span></div><button onClick={() => setShowChanges(false)}>×</button></header>
            {thread.fileChanges.map((file) => <div className="change-file" key={file.path}><FileCode2 size={15} /><div><strong>{file.path}</strong><p>{file.summary}</p></div><span><i>+{file.additions}</i> <b>−{file.deletions}</b></span></div>)}
            {thread.fileChanges.length === 0 && <p className="thread-empty">No file changes recorded yet.</p>}
          </aside>
        )}
      </div>
    </main>
  );
}
