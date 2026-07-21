import { useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CircleHelp,
  Clock3,
  FolderGit2,
  GitPullRequest,
  MessageCircle,
  Orbit,
  PanelLeft,
  PanelLeftClose,
  Plug,
  Search,
  SquarePen,
} from "lucide-react";
import type { AgentStatus, WorkflowStatus } from "../../domain/types";
import { StatusIndicator } from "../ui/StatusIndicator";
import "./codex-shell.css";

export type ShellSection = "threads" | "scheduled" | "loop" | "plugins" | "pull-requests" | "chat";

export interface ShellThreadItem {
  id: string;
  title: string;
  status: AgentStatus;
  nodeName?: string;
  parentWorkflowName?: string;
  loopCreated?: boolean;
}

export interface ShellWorkflowItem {
  id: string;
  name: string;
  description?: string;
  status: WorkflowStatus;
  projectPath?: string;
  activeAgentCount?: number;
}

export interface ShellRunItem {
  id: string;
  label: string;
  status: WorkflowStatus;
}

export interface CodexShellProps {
  children: ReactNode;
  activeSection: ShellSection;
  onNavigate: (section: ShellSection) => void;
  currentWorkflowName?: string;
  workflowThreads?: ShellThreadItem[];
  previousRuns?: ShellRunItem[];
  savedWorkflows?: ShellWorkflowItem[];
  manualThreads?: ShellThreadItem[];
  onOpenWorkflow?: (workflowId: string) => void;
  onOpenRun?: (runId: string) => void;
  onOpenThread?: (threadId: string) => void;
  sidebarOpen?: boolean;
  onSidebarOpenChange?: (open: boolean) => void;
}

const NAVIGATION: Array<{ id: ShellSection; label: string; icon: typeof SquarePen }> = [
  { id: "threads", label: "New task", icon: SquarePen },
  { id: "scheduled", label: "Scheduled", icon: Clock3 },
  { id: "loop", label: "Loop", icon: Orbit },
  { id: "plugins", label: "Plugins", icon: Plug },
  { id: "pull-requests", label: "Pull requests", icon: GitPullRequest },
  { id: "chat", label: "Chat", icon: MessageCircle },
];

export function CodexShell({
  children,
  activeSection,
  onNavigate,
  currentWorkflowName,
  workflowThreads = [],
  savedWorkflows = [],
  onOpenWorkflow,
  onOpenThread,
  sidebarOpen,
  onSidebarOpenChange,
}: CodexShellProps) {
  const [uncontrolledSidebarOpen, setUncontrolledSidebarOpen] = useState(false);
  const isSidebarOpen = sidebarOpen ?? uncontrolledSidebarOpen;
  const setSidebarOpen = onSidebarOpenChange ?? setUncontrolledSidebarOpen;
  const projects = useMemo(() => {
    const groups = new Map<string, ShellWorkflowItem[]>();
    for (const workflow of savedWorkflows) {
      const projectPath = workflow.projectPath || "Configured Loop workspace";
      groups.set(projectPath, [...(groups.get(projectPath) ?? []), workflow]);
    }
    return [...groups].map(([projectPath, workflows]) => ({ projectPath, workflows }));
  }, [savedWorkflows]);

  const navigate = (section: ShellSection) => {
    onNavigate(section);
    setSidebarOpen(false);
  };

  return (
    <div className={`codex-shell${isSidebarOpen ? " codex-shell--sidebar-open" : ""}`}>
      <header className="codex-shell__window-bar" aria-label="Window controls">
        <span className="codex-shell__traffic" aria-hidden="true"><i /><i /><i /></span>
        <button type="button" aria-label="Toggle sidebar" onClick={() => setSidebarOpen(!isSidebarOpen)}><PanelLeft size={14} /></button>
        <button type="button" aria-label="Go back" onClick={() => window.history.back()}><ArrowLeft size={14} /></button>
        <button type="button" aria-label="Go forward" onClick={() => window.history.forward()}><ArrowRight size={14} /></button>
      </header>

      <button type="button" className="codex-shell__scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />

      <aside className="codex-shell__sidebar" aria-label="Codex navigation">
        <div className="codex-shell__brand-row">
          <strong>Codex</strong>
          <button type="button" className="codex-shell__icon-button" aria-label="Search"><Search size={15} /></button>
          <button type="button" className="codex-shell__icon-button codex-shell__close-sidebar" aria-label="Close navigation" onClick={() => setSidebarOpen(false)}><PanelLeftClose size={16} /></button>
        </div>

        <nav className="codex-shell__nav" aria-label="Primary">
          {NAVIGATION.map(({ id, label, icon: Icon }) => (
            <button type="button" key={id} className={`codex-shell__nav-item${activeSection === id ? " is-active" : ""}`} aria-current={activeSection === id ? "page" : undefined} onClick={() => navigate(id)}>
              <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="codex-shell__sidebar-scroll">
          <section className="codex-shell__section" aria-labelledby="pinned-heading">
            <h2 id="pinned-heading" className="codex-shell__section-label">Pinned</h2>
            <button type="button" className="codex-shell__plain-row">Find matching open positions</button>
          </section>

          <section className="codex-shell__section" aria-labelledby="projects-heading">
            <h2 id="projects-heading" className="codex-shell__section-label">Projects</h2>
            <div className="codex-shell__list">
              {projects.map(({ projectPath, workflows }) => {
                const projectName = projectPath === "Configured Loop workspace" ? projectPath : projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath;
                const running = workflows.some((workflow) => workflow.status === "running");
                return <div className="codex-shell__folder codex-shell__project" key={projectPath} title={projectPath}>
                  <div className="codex-shell__folder-row"><FolderGit2 size={13} /><strong>{projectName}</strong><span>{running ? "Running" : "Local"}</span>{running ? <i /> : null}</div>
                  {workflows.map((workflow) => (
                    <button type="button" className="codex-shell__project-task" key={workflow.id} onClick={() => onOpenWorkflow?.(workflow.id)}>
                      <StatusIndicator status={workflow.status} />
                      <span><strong>{workflow.name}</strong><small>{workflow.status === "running" ? `Loop running${workflow.activeAgentCount ? ` · ${workflow.activeAgentCount} active` : ""}` : workflow.description || "Loop"}</small></span>
                    </button>
                  ))}
                </div>;
              })}
            </div>
          </section>

          <section className="codex-shell__section" aria-labelledby="loops-heading">
            <h2 id="loops-heading" className="codex-shell__section-label">Loops</h2>
            <div className="codex-shell__list">
              {savedWorkflows.map((workflow) => {
                const active = workflow.name === currentWorkflowName;
                return (
                  <div className={`codex-shell__folder codex-shell__loop-folder${active ? " is-active" : ""}`} key={workflow.id}>
                    <button type="button" className="codex-shell__folder-row" onClick={() => onOpenWorkflow?.(workflow.id)}>
                      <FolderGit2 size={13} /><strong>{workflow.name}</strong><StatusIndicator status={workflow.status} />
                    </button>
                    {workflow.description ? <button type="button" className="codex-shell__folder-detail codex-shell__loop-description" onClick={() => onOpenWorkflow?.(workflow.id)}>{workflow.description}</button> : null}
                    {active ? workflowThreads.map((thread, index) => (
                      <button type="button" className="codex-shell__nested-thread" key={thread.id} onClick={() => onOpenThread?.(thread.id)}>
                        <span>{index + 1}</span><span>{thread.nodeName ?? thread.title}</span>
                      </button>
                    )) : null}
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <div className="codex-shell__account-row"><span className="codex-shell__avatar">U</span><strong>User</strong><CircleHelp size={14} /></div>
      </aside>

      <main className="codex-shell__main">
        <div className="codex-shell__content">{children}</div>
      </main>
    </div>
  );
}
