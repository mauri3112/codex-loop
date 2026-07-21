import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { CalendarClock, Check, ChevronDown, Copy, Link2, Plus, RefreshCw, Trash2, X, Zap } from "lucide-react";
import type { SingleRunOptions, WebhookParameter, WorkflowRunConfiguration } from "../../domain/types";
import "./run-control.css";

interface RunControlProps {
  configuration: WorkflowRunConfiguration;
  onStart: (options?: SingleRunOptions) => Promise<void>;
  onSave: (configuration: WorkflowRunConfiguration) => Promise<void>;
  disabled?: boolean;
}

const DAYS = [
  { value: 1, short: "M", label: "Monday" },
  { value: 2, short: "T", label: "Tuesday" },
  { value: 3, short: "W", label: "Wednesday" },
  { value: 4, short: "T", label: "Thursday" },
  { value: 5, short: "F", label: "Friday" },
  { value: 6, short: "S", label: "Saturday" },
  { value: 0, short: "S", label: "Sunday" },
] as const;

const MODE_LABELS: Record<WorkflowRunConfiguration["mode"], string> = {
  single: "Single run",
  scheduled: "Scheduled run",
  webhook: "Webhook run",
};

function newToken(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "");
}

function newParameter(): WebhookParameter {
  return { id: globalThis.crypto.randomUUID(), key: "", defaultValue: "" };
}

export function RunControl({ configuration, onStart, onSave, disabled = false }: RunControlProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<"single" | "scheduled" | "webhook" | null>(null);
  const [draft, setDraft] = useState(configuration);
  const [singleRun, setSingleRun] = useState<SingleRunOptions>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);

  const webhookUrl = useMemo(() => `${window.location.origin}/api/triggers/${draft.webhook.token}`, [draft.webhook.token]);
  const payloadExample = useMemo(() => Object.fromEntries(
    draft.webhook.parameters.filter((parameter) => parameter.key.trim()).map((parameter) => [parameter.key.trim(), parameter.defaultValue || "value"]),
  ), [draft.webhook.parameters]);

  const openDialog = (mode: "single" | "scheduled" | "webhook") => {
    setDraft(configuration);
    if (mode === "single") setSingleRun({});
    setError("");
    setMenuOpen(false);
    setDialog(mode);
  };

  const primaryAction = () => {
    if (disabled) return;
    if (configuration.mode === "single") openDialog("single");
    else openDialog(configuration.mode);
  };

  const saveDialog = async (event: FormEvent) => {
    event.preventDefault();
    if (dialog === "scheduled" && (!draft.schedule.days.length || !draft.schedule.times.length)) {
      setError("Choose at least one day and one time.");
      return;
    }
    setPending(true);
    setError("");
    try {
      if (dialog === "single") {
        if (configuration.mode !== "single") await onSave({ ...configuration, mode: "single" });
        await onStart({
          ...(singleRun.additionalPrompt?.trim() ? { additionalPrompt: singleRun.additionalPrompt.trim() } : {}),
          ...(singleRun.workingDirectory?.trim() ? { workingDirectory: singleRun.workingDirectory.trim() } : {}),
        });
        setDialog(null);
        return;
      }
      const next = dialog === "webhook"
        ? { ...draft, mode: "webhook" as const, webhook: { ...draft.webhook, parameters: draft.webhook.parameters.filter((parameter) => parameter.key.trim()).map((parameter) => ({ ...parameter, key: parameter.key.trim() })) } }
        : { ...draft, mode: "scheduled" as const };
      await onSave(next);
      setDialog(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save run settings");
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <div className="run-control" ref={rootRef}>
        <div className="run-control__split">
          <button className="run-control__primary" onClick={primaryAction} disabled={pending || disabled} title={disabled ? "Publish this Loop revision before running" : undefined} data-testid="run-primary">
            <Zap size={13} fill="currentColor" />
            <span>{pending ? "Working…" : MODE_LABELS[configuration.mode]}</span>
          </button>
          <button
            className="run-control__toggle"
            aria-label="Choose how to run"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            disabled={pending || disabled}
            data-testid="run-selector"
          >
            <ChevronDown size={13} />
          </button>
        </div>
        {menuOpen ? (
          <div className="run-menu" role="menu" aria-label="Run options">
            <button role="menuitem" onClick={() => openDialog("single")}>
              <Zap size={15} /><span><strong>Single run</strong><small>Start this loop once, right now</small></span>
              {configuration.mode === "single" ? <Check className="run-menu__check" size={14} /> : null}
            </button>
            <button role="menuitem" onClick={() => openDialog("scheduled")}>
              <CalendarClock size={15} /><span><strong>Scheduled run</strong><small>Run on selected days and times</small></span>
              {configuration.mode === "scheduled" ? <Check className="run-menu__check" size={14} /> : null}
            </button>
            <button role="menuitem" onClick={() => openDialog("webhook")}>
              <Link2 size={15} /><span><strong>Webhook run</strong><small>Start from a URL with optional values</small></span>
              {configuration.mode === "webhook" ? <Check className="run-menu__check" size={14} /> : null}
            </button>
          </div>
        ) : null}
      </div>
      {dialog ? createPortal(
        <div className="run-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) setDialog(null); }}>
          <form className="run-dialog" role="dialog" aria-modal="true" aria-labelledby="run-dialog-title" onSubmit={(event) => void saveDialog(event)}>
            <header>
              <div className="run-dialog__icon">{dialog === "single" ? <Zap size={18} /> : dialog === "scheduled" ? <CalendarClock size={18} /> : <Link2 size={18} />}</div>
              <div><h2 id="run-dialog-title">{dialog === "single" ? "Run this loop once" : dialog === "scheduled" ? "Schedule this loop" : "Create a webhook trigger"}</h2><p>{dialog === "single" ? "Optionally add a one-time instruction or choose a different project folder." : dialog === "scheduled" ? "Choose when Codex Loop should start automatically." : "Call this endpoint to start the loop from another tool or service."}</p></div>
              <button type="button" className="run-dialog__close" aria-label="Close" onClick={() => setDialog(null)} disabled={pending}><X size={16} /></button>
            </header>

            {dialog === "single" ? (
              <div className="run-dialog__body">
                <label className="run-dialog__field"><span>Additional prompt <small>Optional</small></span><textarea autoFocus rows={5} value={singleRun.additionalPrompt ?? ""} onChange={(event) => setSingleRun((current) => ({ ...current, additionalPrompt: event.target.value }))} placeholder="Add context or instructions that apply only to this run…" /><small>This is included in every worker's assignment for this run.</small></label>
                <label className="run-dialog__field"><span>Project folder <small>Optional</small></span><input value={singleRun.workingDirectory ?? ""} onChange={(event) => setSingleRun((current) => ({ ...current, workingDirectory: event.target.value }))} placeholder="/Users/you/Documents/projects/my-project" /><small>Leave blank to use the server's configured Loop workspace.</small></label>
              </div>
            ) : dialog === "scheduled" ? (
              <div className="run-dialog__body">
                <fieldset>
                  <legend>Days of the week</legend>
                  <div className="day-selector">
                    {DAYS.map((day) => {
                      const selected = draft.schedule.days.includes(day.value);
                      return <button key={day.label} type="button" className={selected ? "selected" : ""} aria-pressed={selected} title={day.label} onClick={() => setDraft((current) => ({ ...current, schedule: { ...current.schedule, days: selected ? current.schedule.days.filter((value) => value !== day.value) : [...current.schedule.days, day.value] } }))}>{day.short}</button>;
                    })}
                  </div>
                </fieldset>
                <fieldset>
                  <legend>Run times</legend>
                  <div className="run-time-list">
                    {draft.schedule.times.map((time, index) => (
                      <div key={`${time}-${index}`}>
                        <input type="time" value={time} onChange={(event) => setDraft((current) => ({ ...current, schedule: { ...current.schedule, times: current.schedule.times.map((value, itemIndex) => itemIndex === index ? event.target.value : value) } }))} required />
                        {draft.schedule.times.length > 1 ? <button type="button" aria-label={`Remove ${time}`} onClick={() => setDraft((current) => ({ ...current, schedule: { ...current.schedule, times: current.schedule.times.filter((_, itemIndex) => itemIndex !== index) } }))}><Trash2 size={14} /></button> : null}
                      </div>
                    ))}
                    <button type="button" className="run-dialog__add" onClick={() => setDraft((current) => ({ ...current, schedule: { ...current.schedule, times: [...current.schedule.times, "09:00"] } }))}><Plus size={14} /> Add another time</button>
                  </div>
                </fieldset>
                <label className="run-dialog__field"><span>Time zone</span><input value={draft.schedule.timezone} onChange={(event) => setDraft((current) => ({ ...current, schedule: { ...current.schedule, timezone: event.target.value } }))} placeholder="Europe/Berlin" required /></label>
              </div>
            ) : (
              <div className="run-dialog__body">
                <label className="run-dialog__field"><span>Trigger URL</span><div className="trigger-url"><input value={webhookUrl} readOnly autoFocus /><button type="button" title="Copy URL" aria-label="Copy trigger URL" onClick={() => void navigator.clipboard.writeText(webhookUrl)}><Copy size={14} /></button><button type="button" title="Generate a new URL" aria-label="Generate a new trigger URL" onClick={() => setDraft((current) => ({ ...current, webhook: { ...current.webhook, token: newToken() } }))}><RefreshCw size={14} /></button></div><small>Send a GET request, or POST a JSON object to pass values into the run.</small></label>
                <fieldset>
                  <legend>Optional values</legend>
                  <div className="parameter-list">
                    {draft.webhook.parameters.map((parameter, index) => (
                      <div key={parameter.id} className="parameter-row">
                        <input aria-label={`Value ${index + 1} name`} placeholder="Name" value={parameter.key} onChange={(event) => setDraft((current) => ({ ...current, webhook: { ...current.webhook, parameters: current.webhook.parameters.map((item) => item.id === parameter.id ? { ...item, key: event.target.value } : item) } }))} />
                        <input aria-label={`Value ${index + 1} default`} placeholder="Default value" value={parameter.defaultValue} onChange={(event) => setDraft((current) => ({ ...current, webhook: { ...current.webhook, parameters: current.webhook.parameters.map((item) => item.id === parameter.id ? { ...item, defaultValue: event.target.value } : item) } }))} />
                        <button type="button" aria-label={`Remove value ${index + 1}`} onClick={() => setDraft((current) => ({ ...current, webhook: { ...current.webhook, parameters: current.webhook.parameters.filter((item) => item.id !== parameter.id) } }))}><Trash2 size={14} /></button>
                      </div>
                    ))}
                    <button type="button" className="run-dialog__add" onClick={() => setDraft((current) => ({ ...current, webhook: { ...current.webhook, parameters: [...current.webhook.parameters, newParameter()] } }))}><Plus size={14} /> Add a value</button>
                  </div>
                </fieldset>
                <div className="trigger-example"><span>Example request</span><code>{`curl -X POST '${webhookUrl}' -H 'Content-Type: application/json' -d '${JSON.stringify(payloadExample)}'`}</code></div>
              </div>
            )}

            {error ? <p className="run-dialog__error" role="alert">{error}</p> : null}
            <footer><button type="button" onClick={() => setDialog(null)} disabled={pending}>Cancel</button><button type="submit" className="run-dialog__save" disabled={pending}>{pending ? (dialog === "single" ? "Starting…" : "Saving…") : dialog === "single" ? "Run now" : dialog === "scheduled" ? "Save schedule" : "Activate webhook"}</button></footer>
          </form>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
