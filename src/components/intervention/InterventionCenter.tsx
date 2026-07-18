import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CornerDownRight, ListPlus, MessageSquareMore, Send, Share2, X } from "lucide-react";
import type { CreateInterventionInput, RespondToAttentionInput } from "../../api/client";
import type { AttentionQuestion, AttentionRequest, InterventionDelivery, Workflow } from "../../domain/types";
import { Button } from "../ui/Button";
import "./intervention.css";

interface AttentionBannerProps {
  requests: AttentionRequest[];
  onOpen: (attentionId: string) => void;
}

interface InterventionDrawerProps {
  workflow: Workflow;
  open: boolean;
  initialAttentionId?: string;
  onClose: () => void;
  onIntervene: (input: CreateInterventionInput) => Promise<void>;
  onRespond: (attentionId: string, input: RespondToAttentionInput) => Promise<void>;
  onGateDecision: (nodeId: string, decision: "approve" | "decline") => Promise<void>;
}

type DrawerView = "attention" | "intervene";
type AnswerState = Record<string, { value: string; other: string }>;

const deliveryOptions: Array<{
  value: InterventionDelivery;
  label: string;
  description: string;
  icon: typeof CornerDownRight;
}> = [
  { value: "steer", label: "Steer now", description: "Guide the active turn immediately.", icon: CornerDownRight },
  { value: "queue", label: "Queue follow-up", description: "Start this instruction after the current turn.", icon: ListPlus },
  { value: "context", label: "Share context", description: "Add a constraint for the remaining agents.", icon: Share2 },
];

function requestSummary(request: AttentionRequest) {
  if (request.kind === "user-input") return "Codex needs your answer before this branch can continue.";
  if (request.kind === "approval-gate") return "The Loop is waiting for explicit approval before continuing.";
  if (request.kind === "suspected-stall") return "This branch has not reported meaningful progress recently.";
  if (request.kind === "deadlock") return "No active or launchable agent can move this run forward.";
  if (request.kind === "retry-exhausted") return "An agent used all configured retry attempts.";
  return "The loop supervisor needs your guidance.";
}

function relativeTime(value: string) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

export function AttentionBanner({ requests, onOpen }: AttentionBannerProps) {
  if (requests.length === 0) return null;
  const [first] = requests;
  return (
    <section className="attention-banner" aria-live="polite">
      <span className="attention-banner__icon"><AlertTriangle size={15} aria-hidden="true" /></span>
      <div>
        <strong>{requests.length === 1 ? first.title : `${requests.length} items need input`}</strong>
        <span>{requests.length === 1 ? requestSummary(first) : "Review requests from agents and the loop supervisor."}</span>
      </div>
      <button type="button" onClick={() => onOpen(first.id)}>Review</button>
    </section>
  );
}

function QuestionField({ question, answer, onChange }: {
  question: AttentionQuestion;
  answer: { value: string; other: string };
  onChange: (answer: { value: string; other: string }) => void;
}) {
  const fieldId = `attention-question-${question.id}`;
  if (!question.options) {
    return (
      <label className="intervention-question" htmlFor={fieldId}>
        <span>{question.header}</span>
        <strong>{question.question}</strong>
        {question.isSecret ? (
          <input id={fieldId} type="password" value={answer.value} onChange={(event) => onChange({ ...answer, value: event.target.value })} autoComplete="new-password" />
        ) : (
          <textarea id={fieldId} rows={3} value={answer.value} onChange={(event) => onChange({ ...answer, value: event.target.value })} autoComplete="off" />
        )}
        {question.isSecret ? <small>Your answer is sent to the active turn and is not retained in the audit log.</small> : null}
      </label>
    );
  }

  return (
    <fieldset className="intervention-question">
      <legend><span>{question.header}</span><strong>{question.question}</strong></legend>
      <div className="intervention-options">
        {question.options.map((option) => (
          <label key={option.label} className={answer.value === option.label ? "is-selected" : ""}>
            <input type="radio" name={fieldId} value={option.label} checked={answer.value === option.label} onChange={() => onChange({ ...answer, value: option.label })} />
            <span><strong>{option.label}</strong><small>{option.description}</small></span>
          </label>
        ))}
        {question.isOther ? (
          <label className={answer.value === "__other__" ? "is-selected" : ""}>
            <input type="radio" name={fieldId} value="__other__" checked={answer.value === "__other__"} onChange={() => onChange({ ...answer, value: "__other__" })} />
            <span><strong>Other</strong><small>Provide a different answer.</small></span>
          </label>
        ) : null}
      </div>
      {answer.value === "__other__" ? <input aria-label={`Other answer for ${question.header}`} autoFocus value={answer.other} onChange={(event) => onChange({ ...answer, other: event.target.value })} /> : null}
    </fieldset>
  );
}

export function InterventionDrawer({ workflow, open, initialAttentionId, onClose, onIntervene, onRespond, onGateDecision }: InterventionDrawerProps) {
  const openRequests = useMemo(() => workflow.attentionRequests.filter((request) => request.status === "open"), [workflow.attentionRequests]);
  const [view, setView] = useState<DrawerView>(openRequests.length > 0 ? "attention" : "intervene");
  const [attentionId, setAttentionId] = useState(initialAttentionId ?? openRequests[0]?.id ?? "");
  const [answers, setAnswers] = useState<AnswerState>({});
  const [delivery, setDelivery] = useState<InterventionDelivery>("steer");
  const [threadId, setThreadId] = useState("");
  const [recipientNodeIds, setRecipientNodeIds] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const interventionSubmissionRef = useRef<{ fingerprint: string; idempotencyKey: string } | undefined>(undefined);

  const openRequestIds = openRequests.map((request) => request.id).join(":");
  const selectedRequest = openRequests.find((request) => request.id === attentionId) ?? openRequests[0];
  const activeThreads = workflow.threads.filter((thread) => thread.codex?.state === "running" && thread.codex.activeTurnId);
  const targetThreads = activeThreads;
  const remainingNodes = workflow.nodes.filter((node) => node.status !== "completed");
  const effectiveThreadId = targetThreads.some((thread) => thread.id === threadId) ? threadId : targetThreads[0]?.id ?? "";
  const selectedThread = workflow.threads.find((thread) => thread.id === effectiveThreadId);
  const latestRun = workflow.runs.at(-1);
  const activeRun = latestRun && ["running", "paused"].includes(latestRun.status) ? latestRun : undefined;
  const interventionRun = delivery === "context" && latestRun?.status !== "completed" ? latestRun : activeRun;

  useEffect(() => {
    if (!open) return;
    setView(initialAttentionId || openRequests.length > 0 ? "attention" : "intervene");
    setAttentionId(initialAttentionId ?? openRequests[0]?.id ?? "");
    setError("");
  }, [initialAttentionId, open, openRequestIds]);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(focusTimer);
      restoreFocusRef.current?.focus();
      restoreFocusRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
      if (event.key !== "Tab") return;
      const focusable = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1) as HTMLElement;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open, submitting]);

  if (!open) return null;

  const questions = selectedRequest?.questions ?? [];
  const validAnswers = questions.every((question) => {
    const answer = answers[question.id];
    return Boolean(answer && (answer.value === "__other__" ? answer.other.trim() : answer.value.trim()));
  });
  const canSubmitIntervention = Boolean(interventionRun && message.trim() && (delivery === "context" ? recipientNodeIds.length > 0 : effectiveThreadId));

  const submitAttention = async () => {
    if (!selectedRequest || !validAnswers) return;
    setSubmitting(true);
    setError("");
    const payload = Object.fromEntries(questions.map((question) => {
      const answer = answers[question.id];
      return [question.id, answer.value === "__other__" ? answer.other.trim() : answer.value];
    }));
    try {
      await onRespond(selectedRequest.id, { runId: selectedRequest.runId, expectedTurnId: selectedRequest.expectedTurnId, answers: payload });
      setAnswers({});
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not send your answer");
    } finally {
      setSubmitting(false);
    }
  };

  const submitIntervention = async () => {
    if (!interventionRun || !canSubmitIntervention) return;
    setSubmitting(true);
    setError("");
    const interventionTarget = delivery === "context"
      ? { recipientNodeIds: [...recipientNodeIds].sort() }
      : { threadId: effectiveThreadId, expectedTurnId: selectedThread?.codex?.activeTurnId };
    const fingerprint = JSON.stringify({ runId: interventionRun.id, delivery, message: message.trim(), ...interventionTarget });
    const idempotencyKey = interventionSubmissionRef.current?.fingerprint === fingerprint
      ? interventionSubmissionRef.current.idempotencyKey
      : crypto.randomUUID();
    interventionSubmissionRef.current = { fingerprint, idempotencyKey };
    try {
      await onIntervene({
        runId: interventionRun.id,
        idempotencyKey,
        delivery,
        message: message.trim(),
        ...interventionTarget,
      });
      interventionSubmissionRef.current = undefined;
      setMessage("");
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not deliver intervention");
    } finally {
      setSubmitting(false);
    }
  };

  const submitGate = async (decision: "approve" | "decline") => {
    if (!selectedRequest?.nodeId) return;
    setSubmitting(true);
    setError("");
    try { await onGateDecision(selectedRequest.nodeId, decision); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not resolve approval gate"); }
    finally { setSubmitting(false); }
  };

  return (
    <div className="intervention-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) onClose(); }}>
      <aside ref={drawerRef} className="intervention-drawer" role="dialog" aria-modal="true" aria-labelledby="intervention-title">
        <header>
          <div><span>Loop guardrail</span><h2 id="intervention-title">Keep the work moving</h2></div>
          <button ref={closeButtonRef} type="button" aria-label="Close intervention panel" onClick={onClose} disabled={submitting}><X size={17} /></button>
        </header>
        <nav aria-label="Intervention panel sections">
          {openRequests.length > 0 ? <button type="button" className={view === "attention" ? "is-active" : ""} onClick={() => setView("attention")}><AlertTriangle size={14} /> Needs input <span>{openRequests.length}</span></button> : null}
          <button type="button" className={view === "intervene" ? "is-active" : ""} onClick={() => setView("intervene")}><MessageSquareMore size={14} /> Intervene</button>
        </nav>

        <div className="intervention-drawer__body">
          {view === "attention" && selectedRequest ? (
            <form onSubmit={(event) => { event.preventDefault(); void submitAttention(); }}>
              {openRequests.length > 1 ? (
                <label className="intervention-field"><span>Request</span><select value={selectedRequest.id} onChange={(event) => { setAttentionId(event.target.value); setAnswers({}); }}>
                  {openRequests.map((request) => <option key={request.id} value={request.id}>{request.title}</option>)}
                </select></label>
              ) : null}
              <div className={`attention-card severity-${selectedRequest.severity}`}>
                <span>{selectedRequest.kind.replaceAll("-", " ")} · {relativeTime(selectedRequest.createdAt)}</span>
                <h3>{selectedRequest.title}</h3>
                <p>{selectedRequest.message || requestSummary(selectedRequest)}</p>
              </div>
              {questions.length > 0 ? questions.map((question) => (
                <QuestionField key={question.id} question={question} answer={answers[question.id] ?? { value: "", other: "" }} onChange={(answer) => setAnswers((current) => ({ ...current, [question.id]: answer }))} />
              )) : selectedRequest.kind === "approval-gate" ? <p className="intervention-empty">Approving allows the downstream branch to start. Declining pauses the Loop without rolling back completed work.</p> : <p className="intervention-empty">This request has no structured questions. Use Intervene to send guidance.</p>}
              {error ? <p className="intervention-error" role="alert">{error}</p> : null}
              {selectedRequest.kind === "approval-gate" ? <footer><Button type="button" variant="ghost" onClick={() => void submitGate("decline")} disabled={submitting}>Decline and pause</Button><Button type="button" variant="primary" loading={submitting} onClick={() => void submitGate("approve")}><Send size={14} /> Approve</Button></footer> : <footer><Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button><Button type="submit" variant="primary" loading={submitting} disabled={questions.length === 0 || !validAnswers}><Send size={14} /> Send answer</Button></footer>}
            </form>
          ) : view === "attention" ? (
            <div className="intervention-empty-state"><AlertTriangle size={20} /><h3>No open requests</h3><p>The loop no longer needs an answer.</p><Button onClick={() => setView("intervene")}>Send guidance</Button></div>
          ) : (
            <form onSubmit={(event) => { event.preventDefault(); void submitIntervention(); }}>
              <div className="intervention-intro"><h3>Choose how this guidance is delivered</h3><p>The loop will never guess whether to interrupt an active turn.</p></div>
              <fieldset className="delivery-options"><legend>Delivery</legend>{deliveryOptions.map((option) => {
                const Icon = option.icon;
                const unavailable = option.value !== "context" && activeThreads.length === 0;
                return <label key={option.value} className={delivery === option.value ? "is-selected" : ""} data-disabled={unavailable || undefined}><input type="radio" name="delivery" value={option.value} checked={delivery === option.value} disabled={unavailable} onChange={() => { setDelivery(option.value); if (option.value === "context" && recipientNodeIds.length === 0) setRecipientNodeIds(remainingNodes.map((node) => node.id)); }} /><Icon size={15} /><span><strong>{option.label}</strong><small>{unavailable ? "No active turn is available." : option.description}</small></span></label>;
              })}</fieldset>

              {delivery !== "context" ? (
                <label className="intervention-field"><span>Target agent</span><select value={effectiveThreadId} onChange={(event) => setThreadId(event.target.value)} disabled={targetThreads.length === 0}>
                  {targetThreads.length === 0 ? <option value="">No eligible agent</option> : targetThreads.map((thread) => <option key={thread.id} value={thread.id}>{workflow.nodes.find((node) => node.threadId === thread.id)?.name ?? thread.title}</option>)}
                </select><small>{delivery === "steer" ? "The instruction is added to the active turn." : "The instruction starts once the current turn settles."}</small></label>
              ) : (
                <fieldset className="recipient-field"><legend>Recipients</legend><small>Select the remaining agents that should receive this constraint.</small><div>
                  {remainingNodes.map((node) => <label key={node.id}><input type="checkbox" checked={recipientNodeIds.includes(node.id)} onChange={(event) => setRecipientNodeIds((current) => event.target.checked ? [...current, node.id] : current.filter((id) => id !== node.id))} /><span><strong>{node.name}</strong><small>{node.status}</small></span></label>)}
                </div></fieldset>
              )}

              <label className="intervention-field"><span>Guidance</span><textarea autoFocus rows={5} value={message} onChange={(event) => setMessage(event.target.value)} placeholder={delivery === "context" ? "Add a decision, constraint, or clarification…" : "Tell this agent what changed or how to proceed…"} /><small>{delivery === "context" ? "Creates a manual Context Block visible only to the selected agents." : "Your message is recorded in the run activity for traceability."}</small></label>

              <div className="delivery-preview" aria-live="polite"><strong>What happens next</strong><p>{delivery === "steer" ? `Guidance is delivered immediately to ${selectedThread?.title ?? "the selected active agent"}.` : delivery === "queue" ? `A single follow-up turn is queued for ${selectedThread?.title ?? "the selected agent"}.` : `A shared constraint is created for ${recipientNodeIds.length} selected ${recipientNodeIds.length === 1 ? "agent" : "agents"}.`}</p></div>
              {error ? <p className="intervention-error" role="alert">{error}</p> : null}
              {!interventionRun ? <p className="intervention-error" role="alert">Start a workflow run before sending guidance.</p> : null}
              <footer><Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button><Button type="submit" variant="primary" loading={submitting} disabled={!canSubmitIntervention}><Send size={14} /> Deliver guidance</Button></footer>
            </form>
          )}
        </div>
      </aside>
    </div>
  );
}
