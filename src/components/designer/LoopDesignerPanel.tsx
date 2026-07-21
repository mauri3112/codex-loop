import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, KeyRound, RotateCcw, Send, Sparkles, Unplug } from "lucide-react";
import type { Workflow } from "../../domain/types";
import { SlashAutocompleteTextArea } from "../ui/SlashAutocompleteTextArea";
import { shouldSubmitComposer } from "../ui/composer-keyboard";
import "./designer.css";

export function LoopDesignerPanel({ workflow, sending, onSend, onUndo }: {
  workflow: Workflow;
  sending: boolean;
  onSend: (message: string) => Promise<void>;
  onUndo: () => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const messagesRef = useRef<HTMLDivElement>(null);
  const lastMutation = workflow.mutations.at(-1);
  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: "smooth" });
  }, [workflow.designer.messages.length, sending]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = message.trim();
    if (!value || sending) return;
    setMessage("");
    try { await onSend(value); } catch { setMessage(value); }
  };

  return (
    <aside className="loop-designer" aria-label="Loop Designer chat">
      <header className="loop-designer__header">
        <span className="loop-designer__mark"><Sparkles size={15} aria-hidden="true" /></span>
        <div><strong>Loop Designer</strong><span>{workflow.designer.effectiveModel ?? workflow.designer.configuredModel} · revision {workflow.revision}</span></div>
        {lastMutation ? <button type="button" onClick={() => void onUndo()} title={`Undo: ${lastMutation.rationale}`} disabled={sending}><RotateCcw size={14} /><span>Undo</span></button> : null}
      </header>

      <div className="loop-designer__messages" ref={messagesRef}>
        {workflow.designer.messages.length === 0 ? (
          <section className="loop-designer__welcome">
            <Sparkles size={20} aria-hidden="true" />
            <h2>Describe the Loop you want</h2>
            <p>I’ll determine the agents, dependencies, verification, limits, and required integrations. You can refine everything here or switch to visual editing.</p>
            <div>
              <button type="button" onClick={() => setMessage("Create a Loop that investigates an issue, implements a fix, runs the repository checks, and independently reviews the result.")}>Repository change</button>
              <button type="button" onClick={() => setMessage("Create a recurring Loop that triages new GitHub issues, identifies actionable bugs, and prepares verified draft fixes.")}>GitHub triage</button>
            </div>
          </section>
        ) : workflow.designer.messages.map((item) => (
          <article className={`loop-designer__message is-${item.role}${item.status === "failed" ? " is-failed" : ""}`} key={item.id}>
            <span>{item.role === "user" ? "You" : "Designer"}</span>
            <p>{item.content}</p>
            {item.mutationId ? <small>Graph updated</small> : null}
          </article>
        ))}
        {sending ? <article className="loop-designer__message is-assistant is-working"><span>Designer</span><p><i /><i /><i /> Designing and validating the next revision…</p></article> : null}

        {workflow.designer.pendingQuestions.length ? <section className="loop-designer__questions"><strong>I still need to know</strong>{workflow.designer.pendingQuestions.map((question) => <p key={question}>{question}</p>)}</section> : null}
        {workflow.designer.assumptions.length ? <details className="loop-designer__assumptions"><summary>Assumptions ({workflow.designer.assumptions.length})</summary>{workflow.designer.assumptions.map((assumption) => <p key={assumption}>{assumption}</p>)}</details> : null}
      </div>

      <div className="loop-designer__status">
        {workflow.validationIssues.filter((issue) => issue.severity === "error").length ? <span className="is-error"><AlertTriangle size={12} />{workflow.validationIssues.filter((issue) => issue.severity === "error").length} validation errors</span> : <span className="is-valid"><CheckCircle2 size={12} />Definition valid</span>}
        {workflow.capabilityBindings.filter((binding) => binding.status !== "available").length ? <span><Unplug size={12} />{workflow.capabilityBindings.filter((binding) => binding.status !== "available").length} integrations need setup</span> : null}
        {workflow.secretRequirements.filter((secret) => secret.status !== "bound").length ? <span><KeyRound size={12} />{workflow.secretRequirements.filter((secret) => secret.status !== "bound").length} secrets need binding</span> : null}
      </div>

      <form className="loop-designer__composer" onSubmit={submit}>
        <SlashAutocompleteTextArea
          value={message}
          onChange={setMessage}
          rows={3}
          placeholder="Create or update this Loop…"
          onKeyDown={(event) => {
            if (shouldSubmitComposer(event)) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <footer><span>Use / to add skills, apps, or MCP capabilities</span><button type="submit" disabled={!message.trim() || sending} aria-label="Send to Loop Designer"><Send size={14} /></button></footer>
      </form>
    </aside>
  );
}
