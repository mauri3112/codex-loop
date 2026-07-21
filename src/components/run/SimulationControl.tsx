import { useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Beaker, CheckCircle2, CircleX, LoaderCircle, LockKeyhole, RefreshCw, X } from "lucide-react";
import type { SimulationOptions, WorkflowSimulationReport } from "../../domain/simulation-report";
import "./simulation-control.css";

interface SimulationControlProps {
  onSimulate: (options?: SimulationOptions) => Promise<WorkflowSimulationReport>;
  disabled?: boolean;
}

function CheckIcon({ status }: { status: "pass" | "warning" | "fail" }) {
  if (status === "pass") return <CheckCircle2 size={14} />;
  if (status === "warning") return <AlertTriangle size={14} />;
  return <CircleX size={14} />;
}

export function SimulationControl({ onSimulate, disabled = false }: SimulationControlProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [workingDirectory, setWorkingDirectory] = useState("");
  const [report, setReport] = useState<WorkflowSimulationReport>();
  const [error, setError] = useState("");

  const simulate = async (options?: SimulationOptions) => {
    setPending(true);
    setError("");
    try {
      setReport(await onSimulate(options));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not simulate this Loop");
    } finally {
      setPending(false);
    }
  };

  const openSimulation = () => {
    if (disabled) return;
    setOpen(true);
    setWorkingDirectory("");
    setReport(undefined);
    setError("");
    void simulate();
  };

  const rerun = (event: FormEvent) => {
    event.preventDefault();
    void simulate(workingDirectory.trim() ? { workingDirectory: workingDirectory.trim() } : undefined);
  };

  return (
    <>
      <button type="button" className="simulate-control" onClick={openSimulation} disabled={disabled || pending} title="Preview this Loop without creating threads or changing anything" data-testid="simulate-loop">
        <Beaker size={14} /><span>Simulate</span>
      </button>
      {open ? createPortal(
        <div className="simulation-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) setOpen(false); }}>
          <section className="simulation-dialog" role="dialog" aria-modal="true" aria-labelledby="simulation-title">
            <header className="simulation-dialog__header">
              <div className="simulation-dialog__mark"><Beaker size={18} /></div>
              <div><h2 id="simulation-title">Simulate this Loop</h2><p>Preview thread procedures and verify access with read-only checks.</p></div>
              <span className="simulation-dialog__readonly"><LockKeyhole size={11} /> Read only</span>
              <button type="button" aria-label="Close simulation" onClick={() => setOpen(false)} disabled={pending}><X size={16} /></button>
            </header>

            <form className="simulation-dialog__workspace" onSubmit={rerun}>
              <label><span>Project folder</span><input value={workingDirectory} onChange={(event) => setWorkingDirectory(event.target.value)} placeholder={report?.workingDirectory ?? "Use the configured Loop workspace"} /></label>
              <button type="submit" disabled={pending}><RefreshCw size={13} />{pending ? "Checking…" : "Run again"}</button>
            </form>

            <div className="simulation-dialog__scroll">
              {pending && !report ? <div className="simulation-loading"><LoaderCircle size={20} /><strong>Checking the Loop safely…</strong><span>No worker threads or tools are being started.</span></div> : null}
              {error ? <div className="simulation-error" role="alert"><CircleX size={15} /><span>{error}</span></div> : null}
              {report ? (
                <>
                  <section className={`simulation-summary is-${report.status}`}>
                    <div><CheckIcon status={report.status === "sound" ? "pass" : report.status === "blocked" ? "fail" : "warning"} /><span>{report.status.replace("-", " ")}</span></div>
                    <h3>{report.summary}</h3>
                    <p>{report.steps.length} simulated thread procedure(s) · revision {report.workflowRevision} · no state persisted</p>
                  </section>

                  <section className="simulation-section">
                    <header><div><LockKeyhole size={14} /><h3>Read-only checks</h3></div><span>{report.checks.filter((check) => check.status === "pass").length}/{report.checks.length} passed</span></header>
                    <div className="simulation-checks">
                      {report.checks.map((check) => <article key={check.id} className={`is-${check.status}`}><CheckIcon status={check.status} /><div><strong>{check.label}</strong><p>{check.detail}</p></div><span>{check.category}</span></article>)}
                    </div>
                  </section>

                  <section className="simulation-section">
                    <header><div><Beaker size={14} /><h3>Possible execution</h3></div><span>{Math.max(0, ...report.steps.map((step) => step.stage))} stages</span></header>
                    <div className="simulation-steps">
                      {report.steps.map((step) => (
                        <article key={step.nodeId} className={`is-${step.status}`}>
                          <header><span>{step.sequence}</span><div><strong>{step.nodeName}</strong><small>Stage {step.stage} · {step.kind} · {step.status.replace("-", " ")}</small></div></header>
                          {step.dependsOn.length ? <p className="simulation-steps__depends">After {step.dependsOn.join(", ")}</p> : null}
                          <ol>{step.procedure.map((procedure) => <li key={procedure}>{procedure}</li>)}</ol>
                          <div className="simulation-steps__output"><strong>Possible output</strong><p>{step.possibleOutput}</p></div>
                        </article>
                      ))}
                    </div>
                  </section>

                  <section className="simulation-final-output"><strong>Possible Loop output</strong><p>{report.possibleFinalOutput}</p><small>Illustrative only. No model was asked to generate this result.</small></section>
                </>
              ) : null}
            </div>
          </section>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
