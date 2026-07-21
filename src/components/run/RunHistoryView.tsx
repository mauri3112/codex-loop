import { ArrowLeft, CheckCircle2, Clock3, FileCode2, GitCommitHorizontal, MessageSquareText, TerminalSquare } from "lucide-react";
import type { Workflow } from "../../domain/types";
import "./run-history.css";

export function RunHistoryView({ workflow, runId, onBack }: { workflow: Workflow; runId: string; onBack: () => void }) {
  const run = workflow.runs.find((item) => item.id === runId);
  if (!run) return <main className="run-history run-history--missing"><p>Run not found.</p><button onClick={onBack}>Return to Loop</button></main>;
  const runNumber = workflow.runs.findIndex((item) => item.id === run.id) + 1;
  const results = run.threadResults ?? [];
  const started = run.startedAt ? new Date(run.startedAt) : undefined;
  const completed = run.completedAt ? new Date(run.completedAt) : undefined;

  return (
    <main className="run-history">
      <header className="run-history__topbar">
        <button onClick={onBack}><ArrowLeft size={15} /> Back to Loop</button>
        <div><strong>Run {runNumber}</strong><span>{workflow.name}</span></div>
        <span className={`run-history__status status-${run.status}`}>{run.status}</span>
      </header>
      <div className="run-history__scroll">
        <section className="run-history__summary">
          <div className="run-history__eyebrow"><Clock3 size={14} /> Execution history</div>
          <h1>{run.additionalPrompt || workflow.mainTask}</h1>
          <dl>
            <div><dt>Started</dt><dd>{started?.toLocaleString() ?? "Not recorded"}</dd></div>
            <div><dt>Finished</dt><dd>{completed?.toLocaleString() ?? (run.status === "running" ? "Still running" : "Not recorded")}</dd></div>
            <div><dt>Trigger</dt><dd>{run.source ?? "manual"}</dd></div>
            <div><dt>Working directory</dt><dd>{run.workingDirectory ?? "Configured Loop workspace"}</dd></div>
            <div><dt>Workflow revision</dt><dd>{run.workflowRevision ?? "Unknown"}</dd></div>
            <div><dt>Repository revision</dt><dd><GitCommitHorizontal size={12} />{run.repositoryRevision ?? "Not a Git repository"}</dd></div>
          </dl>
        </section>

        <section className="run-history__results">
          <header><div><CheckCircle2 size={15} /><h2>Thread results</h2></div><span>{results.length}</span></header>
          {results.length ? results.map((thread) => (
            <article className="run-history__thread" key={thread.id}>
              <header><span className={`run-history__thread-dot status-${thread.status}`} /><div><strong>{thread.title}</strong><small>{thread.model} · {thread.status}</small></div></header>
              <p>{thread.task}</p>
              {thread.finalOutput ? <div className="run-history__output"><strong>Final output</strong><p>{thread.finalOutput}</p></div> : <div className="run-history__output is-empty">No final output was recorded.</div>}
              <div className="run-history__counts"><span><MessageSquareText size={12} />{thread.messages.length} messages</span><span><TerminalSquare size={12} />{thread.toolCalls.length} tool calls</span><span><FileCode2 size={12} />{thread.fileChanges.length} files</span></div>
              {(thread.messages.length > 0 || thread.toolCalls.length > 0) ? <details><summary>Execution details</summary>
                <div className="run-history__timeline">
                  {thread.messages.map((message) => <div key={message.id}><strong>{message.role === "assistant" ? thread.title : message.role === "user" ? "You" : "Loop"}</strong><time>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><p>{message.content}</p></div>)}
                  {thread.toolCalls.map((tool) => <div key={tool.id} className="is-tool"><strong>{tool.name}</strong><span>{tool.status}</span><code>{tool.command}</code><pre>{tool.output}</pre></div>)}
                </div>
              </details> : null}
            </article>
          )) : <div className="run-history__empty">This run predates execution snapshots or has not produced a thread result yet.</div>}
        </section>
      </div>
    </main>
  );
}
