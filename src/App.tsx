import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { CircleStop, MoreHorizontal, Pause, Play, RotateCcw, Save, Sparkles } from "lucide-react";
import { api } from "./api/client";
import { ActivityPanel } from "./components/activity/ActivityPanel";
import { LoopWorkspaceCanvas } from "./components/canvas";
import { LoopLanding, type LoopTemplateItem } from "./components/landing/LoopLanding";
import { RunControl } from "./components/run/RunControl";
import { CodexShell, type ShellSection } from "./components/shell/CodexShell";
import { AgentThreadView } from "./components/thread/AgentThreadView";
import { Button } from "./components/ui/Button";
import type { AppData, Selection, Workflow, WorkflowRunConfiguration } from "./domain/types";
import "./styles/app.css";

function sectionForPath(pathname: string): ShellSection {
  if (pathname.startsWith("/loop")) return "loop";
  if (pathname.startsWith("/scheduled")) return "scheduled";
  if (pathname.startsWith("/plugins")) return "plugins";
  if (pathname.startsWith("/pull-requests")) return "pull-requests";
  if (pathname.startsWith("/chat")) return "chat";
  return "threads";
}

function StaticCodexScreen({ section }: { section: Exclude<ShellSection, "loop"> }) {
  const copy = {
    threads: ["New task", "Start a task in the current project.", "What should we work on?"],
    scheduled: ["Scheduled", "Review recurring and queued tasks.", "No scheduled tasks"],
    plugins: ["Plugins", "Manage installed Codex plugins.", "Your plugins"],
    "pull-requests": ["Pull requests", "Review active repository changes.", "No pull requests need attention"],
    chat: ["Chat", "Continue a conversation with Codex.", "Start a chat"],
  }[section];
  return <main className="static-screen"><header><h1>{copy[0]}</h1><MoreHorizontal size={16} /></header><section><div className="static-mark"><Sparkles size={20} /></div><h2>{copy[2]}</h2><p>{copy[1]}</p>{section === "threads" && <div className="static-composer">Ask Codex to change, review, or explain code… <span>↑</span></div>}</section></main>;
}

interface WorkspaceProps {
  data: AppData;
  onChange: (workflow: Workflow) => void;
  onSave: (workflow: Workflow) => Promise<void>;
  onRunAction: (workflow: Workflow, action: "start" | "pause" | "resume" | "stop" | "reset") => Promise<void>;
  onConfigureRun: (workflow: Workflow, configuration: WorkflowRunConfiguration) => Promise<void>;
  onOpenThread: (id: string) => void;
}

function Workspace({ data, onChange, onSave, onRunAction, onConfigureRun, onOpenThread }: WorkspaceProps) {
  const { workflowId = "" } = useParams();
  const navigate = useNavigate();
  const workflow = data.workflows.find((item) => item.id === workflowId);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [activityOpen, setActivityOpen] = useState(true);
  const [saving, setSaving] = useState(false);
  if (!workflow) return <main className="workflow-missing"><h1>Workflow not found</h1><button onClick={() => navigate("/loop")}>Return to Loop</button></main>;

  const run = workflow.runs.at(-1);
  const completed = workflow.nodes.filter((node) => node.status === "completed").length;
  const progress = workflow.nodes.length ? Math.round(workflow.nodes.reduce((sum, node) => sum + node.progress, 0) / workflow.nodes.length) : 0;
  const runAction = (action: "start" | "pause" | "resume" | "stop" | "reset") => onRunAction(workflow, action);
  const save = async () => { setSaving(true); try { await onSave(workflow); } finally { setSaving(false); } };
  const selectFromActivity = (nodeId: string) => setSelection({ type: "agent", id: nodeId });

  return (
    <main className="loop-workspace">
      <header className="workspace-header">
        <div className="workspace-identity"><h1>{workflow.name}</h1><span className={`workflow-state state-${workflow.status}`}>{workflow.status}</span></div>
        <div className="workspace-progress" aria-label={`${progress}% workflow progress`}><span><i style={{ width: `${progress}%` }} /></span><small>{completed}/{workflow.nodes.length} complete</small></div>
        <div className="workspace-controls">
          {!run || ["stopped", "completed"].includes(run.status) ? <RunControl configuration={workflow.runConfiguration} onStart={() => runAction("start")} onSave={(configuration) => onConfigureRun(workflow, configuration)} /> : run.status === "paused" ? <button className="run-primary" onClick={() => void runAction("resume")}><Play size={14} /> Resume</button> : <button onClick={() => void runAction("pause")}><Pause size={14} /> Pause</button>}
          {run && ["running", "paused"].includes(run.status) && <button onClick={() => void runAction("stop")} title="Stop workflow"><CircleStop size={14} /><span>Stop</span></button>}
          <button onClick={() => void runAction("reset")} title="Reset workflow"><RotateCcw size={14} /><span>Reset</span></button>
          <Button variant="secondary" onClick={save} loading={saving}><Save size={14} />{workflow.saved ? "Saved" : "Save"}</Button>
        </div>
      </header>
      <div className="workspace-content">
        <LoopWorkspaceCanvas workflow={workflow} selection={selection} onSelectionChange={setSelection} onWorkflowChange={onChange} onOpenThread={onOpenThread} />
        <ActivityPanel
          events={workflow.events}
          contexts={workflow.contextBlocks}
          agents={workflow.nodes}
          open={activityOpen}
          onToggle={() => setActivityOpen((value) => !value)}
          onSelectNode={selectFromActivity}
          onSelectContext={(id) => setSelection({ type: "context", id })}
        />
      </div>
    </main>
  );
}

export function App() {
  const [data, setData] = useState<AppData | null>(null);
  const [error, setError] = useState("");
  const [generating, setGenerating] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const persistQueue = useRef<Promise<unknown>>(Promise.resolve());

  const refresh = useCallback(async () => {
    try { setData(await api.data()); setError(""); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load Codex Loop"); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const persist = useCallback((workflow: Workflow) => {
    persistQueue.current = persistQueue.current.then(() => api.update(workflow)).catch((reason) => { setError(reason instanceof Error ? reason.message : "Could not save workflow"); });
  }, []);

  const changeWorkflow = useCallback((workflow: Workflow) => {
    setData((current) => current ? { ...current, workflows: current.workflows.map((item) => item.id === workflow.id ? workflow : item) } : current);
    persist(workflow);
  }, [persist]);

  const routeWorkflowId = location.pathname.match(/^\/loop\/([^/]+)/)?.[1];
  const activeWorkflow = data?.workflows.find((item) => item.id === routeWorkflowId);
  const hasLiveCodexWork = data?.workflows.some((workflow) => workflow.status === "running" || workflow.threads.some((thread) => ["starting", "running"].includes(thread.codex?.state ?? "")));
  useEffect(() => {
    if (!hasLiveCodexWork) return;
    const timer = window.setInterval(() => { void refresh(); }, 800);
    return () => window.clearInterval(timer);
  }, [hasLiveCodexWork, refresh]);

  const generate = async (task: string) => {
    setGenerating(true);
    try {
      const workflow = await api.generate(task);
      setData((current) => current ? { ...current, workflows: [workflow, ...current.workflows] } : current);
      navigate(`/loop/${workflow.id}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not generate workflow"); } finally { setGenerating(false); }
  };
  const create = async () => {
    try { const workflow = await api.create(); setData((current) => current ? { ...current, workflows: [workflow, ...current.workflows] } : current); navigate(`/loop/${workflow.id}`); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create workflow"); }
  };
  const save = async (workflow: Workflow) => {
    const updated = await api.update(workflow);
    const saved = await api.save(updated.id);
    setData((current) => current ? { ...current, workflows: current.workflows.map((item) => item.id === saved.id ? saved : item) } : current);
  };
  const replaceWorkflow = (workflow: Workflow) => {
    setData((current) => current ? { ...current, workflows: current.workflows.map((item) => item.id === workflow.id ? workflow : item) } : current);
  };
  const runAction = async (workflow: Workflow, action: "start" | "pause" | "resume" | "stop" | "reset") => {
    try { replaceWorkflow(await api.runAction(workflow.id, action)); } catch (reason) { setError(reason instanceof Error ? reason.message : `Could not ${action} workflow`); }
  };
  const configureRun = async (workflow: Workflow, configuration: WorkflowRunConfiguration) => {
    try { replaceWorkflow(await api.configureRun(workflow.id, configuration)); }
    catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not save run settings";
      setError(message);
      throw reason;
    }
  };
  const sendInstruction = async (workflowId: string, threadId: string, instruction: string) => {
    replaceWorkflow(await api.sendInstruction(workflowId, threadId, instruction));
  };
  const stopThread = async (workflowId: string, threadId: string) => {
    replaceWorkflow(await api.stopThread(workflowId, threadId));
  };
  const resolveApproval = async (workflowId: string, threadId: string, decision: "accept" | "decline") => {
    replaceWorkflow(await api.resolveApproval(workflowId, threadId, decision));
  };

  if (!data && !error) return <div className="app-loading"><span /><p>Opening Codex…</p></div>;
  if (!data) return <div className="app-error"><h1>Codex Loop couldn’t open</h1><p>{error}</p><button onClick={() => void refresh()}>Try again</button></div>;

  const activeSection = sectionForPath(location.pathname);
  const workflowForThread = data.workflows.find((workflow) => workflow.threads.some((thread) => location.pathname.endsWith(thread.id)));
  const shellWorkflow = activeWorkflow ?? workflowForThread;
  return (
    <CodexShell
      activeSection={activeSection}
      onNavigate={(section) => {
        if (section === "loop") navigate(`/loop/${activeWorkflow?.id ?? data.workflows[0]?.id ?? ""}`);
        else navigate(section === "threads" ? "/threads" : `/${section}`);
      }}
      currentWorkflowName={shellWorkflow?.name}
      workflowThreads={shellWorkflow?.nodes.map((node) => ({ id: node.threadId, title: node.task, nodeName: node.name, status: node.status, loopCreated: true, parentWorkflowName: shellWorkflow.name }))}
      previousRuns={shellWorkflow?.runs.map((run, index) => ({ id: run.id, label: `Run ${index + 1} · ${run.startedAt ? new Date(run.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Not started"}`, status: run.status === "idle" ? "ready" : run.status }))}
      savedWorkflows={data.workflows.map((workflow) => ({ id: workflow.id, name: workflow.name, description: workflow.mainTask, status: workflow.status }))}
      manualThreads={data.manualThreads}
      onOpenWorkflow={(id) => navigate(`/loop/${id}`)}
      onOpenThread={(id) => data.workflows.some((workflow) => workflow.threads.some((thread) => thread.id === id)) ? navigate(`/threads/${id}`) : navigate("/threads")}
    >
      {error && <div className="app-toast" role="alert">{error}<button onClick={() => setError("")}>×</button></div>}
      <Routes>
        <Route path="/" element={<Navigate to="/loop" replace />} />
        <Route path="/loop" element={data.workflows.length > 0 ? <Navigate to={`/loop/${data.workflows[0].id}`} replace /> : <LoopLanding generating={generating} recentWorkflows={[]} savedWorkflows={[]} templates={data.templates} onCreate={() => void create()} onGenerate={(task) => void generate(task)} onOpenWorkflow={(id) => navigate(`/loop/${id}`)} onUseTemplate={(template: LoopTemplateItem) => void generate(template.title)} />} />
        <Route path="/loop/:workflowId" element={<Workspace data={data} onChange={changeWorkflow} onSave={save} onRunAction={runAction} onConfigureRun={configureRun} onOpenThread={(id) => navigate(`/threads/${id}`)} />} />
        <Route path="/threads/:threadId" element={<ThreadRoute data={data} onSend={sendInstruction} onStop={stopThread} onResolveApproval={resolveApproval} />} />
        <Route path="/threads" element={<StaticCodexScreen section="threads" />} />
        <Route path="/scheduled" element={<StaticCodexScreen section="scheduled" />} />
        <Route path="/plugins" element={<StaticCodexScreen section="plugins" />} />
        <Route path="/pull-requests" element={<StaticCodexScreen section="pull-requests" />} />
        <Route path="/chat" element={<StaticCodexScreen section="chat" />} />
        <Route path="*" element={<Navigate to="/loop" replace />} />
      </Routes>
    </CodexShell>
  );
}

function ThreadRoute({ data, onSend, onStop, onResolveApproval }: { data: AppData; onSend: (workflowId: string, threadId: string, instruction: string) => Promise<void>; onStop: (workflowId: string, threadId: string) => Promise<void>; onResolveApproval: (workflowId: string, threadId: string, decision: "accept" | "decline") => Promise<void> }) {
  const { threadId = "" } = useParams();
  const navigate = useNavigate();
  const workflow = useMemo(() => data.workflows.find((item) => item.threads.some((thread) => thread.id === threadId)), [data.workflows, threadId]);
  if (!workflow) return <StaticCodexScreen section="threads" />;
  return <AgentThreadView workflow={workflow} threadId={threadId} onBack={() => navigate(`/loop/${workflow.id}`)} onSend={(instruction) => onSend(workflow.id, threadId, instruction)} onStop={() => onStop(workflow.id, threadId)} onResolveApproval={(decision) => onResolveApproval(workflow.id, threadId, decision)} />;
}
