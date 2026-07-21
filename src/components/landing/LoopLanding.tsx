import { useState, type FormEvent } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  FileSearch,
  GitBranch,
  GitPullRequest,
  ListChecks,
  Plus,
  RefreshCcw,
  SearchCheck,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";
import type { WorkflowStatus } from "../../domain/types";
import { Button } from "../ui/Button";
import { shouldSubmitComposer } from "../ui/composer-keyboard";
import { StatusIndicator } from "../ui/StatusIndicator";
import "./loop-landing.css";

export interface LandingWorkflowItem {
  id: string;
  name: string;
  description?: string;
  status: WorkflowStatus;
  updatedLabel: string;
  nodeCount?: number;
}

export interface LoopTemplateItem {
  id: string;
  title: string;
  description: string;
}

export interface LoopLandingProps {
  recentWorkflows?: LandingWorkflowItem[];
  savedWorkflows?: LandingWorkflowItem[];
  templates?: LoopTemplateItem[];
  generating?: boolean;
  onCreate: () => void;
  onGenerate: (task: string) => void;
  onOpenWorkflow: (workflowId: string) => void;
  onUseTemplate: (template: LoopTemplateItem) => void;
}

export const DEFAULT_LOOP_TEMPLATES: LoopTemplateItem[] = [
  { id: "fix-ci", title: "Investigate and fix a failing CI pipeline", description: "Trace failures, implement a fix, verify checks, and review the result." },
  { id: "feature", title: "Implement and review a feature", description: "Plan, build, test, and independently review a product change." },
  { id: "refactor", title: "Refactor a subsystem safely", description: "Map dependencies, make focused changes, and guard behavior with tests." },
  { id: "audit", title: "Audit a repository", description: "Inspect architecture, security, quality, and operational risks in parallel." },
  { id: "pr-feedback", title: "Resolve pull-request feedback", description: "Triage review threads, implement fixes, test, and summarize resolutions." },
  { id: "full-change", title: "Plan, implement, test, and document a change", description: "Coordinate a complete engineering workflow with explicit handoffs." },
];

const TEMPLATE_ICONS = [SearchCheck, Wrench, RefreshCcw, ShieldCheck, GitPullRequest, ListChecks];

function WorkflowList({
  items,
  emptyLabel,
  onOpen,
}: {
  items: LandingWorkflowItem[];
  emptyLabel: string;
  onOpen: (workflowId: string) => void;
}) {
  if (items.length === 0) {
    return <div className="loop-landing__empty">{emptyLabel}</div>;
  }

  return (
    <div className="loop-landing__workflow-list">
      {items.map((workflow) => (
        <button type="button" className="loop-landing__workflow-row" key={workflow.id} onClick={() => onOpen(workflow.id)}>
          <span className="loop-landing__workflow-icon" aria-hidden="true"><GitBranch size={15} /></span>
          <span className="loop-landing__workflow-copy">
            <span className="loop-landing__workflow-name">{workflow.name}</span>
            <span className="loop-landing__workflow-detail">
              {workflow.description ? `${workflow.description} · ` : ""}{workflow.nodeCount ? `${workflow.nodeCount} agents · ` : ""}{workflow.updatedLabel}
            </span>
          </span>
          <StatusIndicator status={workflow.status} showLabel />
          <ArrowRight className="loop-landing__row-arrow" size={14} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

export function LoopLanding({
  recentWorkflows = [],
  savedWorkflows = [],
  templates = DEFAULT_LOOP_TEMPLATES,
  generating = false,
  onCreate,
  onGenerate,
  onOpenWorkflow,
  onUseTemplate,
}: LoopLandingProps) {
  const [task, setTask] = useState("");
  const canGenerate = task.trim().length > 0 && !generating;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedTask = task.trim();
    if (normalizedTask) onGenerate(normalizedTask);
  };

  return (
    <main className="loop-landing">
      <div className="loop-landing__topbar">
        <div className="loop-landing__title-row">
          <GitBranch size={17} aria-hidden="true" />
          <h1>Loop</h1>
        </div>
        <Button variant="secondary" onClick={onCreate}><Plus size={15} aria-hidden="true" />Create Loop</Button>
      </div>

      <div className="loop-landing__scroll">
        <div className="loop-landing__container">
          <section className="loop-landing__intro" aria-labelledby="loop-intro-heading">
            <div className="loop-landing__intro-mark" aria-hidden="true">
              <GitBranch size={21} strokeWidth={1.7} />
            </div>
            <div>
              <h2 id="loop-intro-heading">Describe the outcome. Codex designs the Loop.</h2>
              <p>Start with as much detail as you have. The Loop Designer will infer the agents, dependencies, verification, permissions, and limits, then ask only for consequential missing information.</p>
            </div>
          </section>

          <form className="loop-landing__composer" onSubmit={submit}>
            <label htmlFor="loop-task">What should Codex coordinate?</label>
            <textarea
              id="loop-task"
              value={task}
              onChange={(event) => setTask(event.target.value)}
              onKeyDown={(event) => {
                if (shouldSubmitComposer(event)) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Describe a repository-level task, feature, investigation, or review…"
              rows={3}
            />
            <div className="loop-landing__composer-footer">
              <span><Sparkles size={13} aria-hidden="true" />Continue in chat and edit the generated graph only when you want to.</span>
              <Button type="submit" variant="primary" disabled={!canGenerate} loading={generating}>
                Start designing<ArrowRight size={14} aria-hidden="true" />
              </Button>
            </div>
          </form>

          <div className="loop-landing__workflow-columns">
            <section aria-labelledby="recent-workflows-heading">
              <div className="loop-landing__section-heading">
                <div><Clock3 size={15} aria-hidden="true" /><h2 id="recent-workflows-heading">Recent</h2></div>
                <span>{recentWorkflows.length}</span>
              </div>
              <WorkflowList items={recentWorkflows} emptyLabel="Your recent Loop workflows will appear here." onOpen={onOpenWorkflow} />
            </section>

            <section aria-labelledby="saved-workflows-heading">
              <div className="loop-landing__section-heading">
                <div><CheckCircle2 size={15} aria-hidden="true" /><h2 id="saved-workflows-heading">Saved</h2></div>
                <span>{savedWorkflows.length}</span>
              </div>
              <WorkflowList items={savedWorkflows} emptyLabel="Save a workflow to reuse it later." onOpen={onOpenWorkflow} />
            </section>
          </div>

          <section className="loop-landing__templates" aria-labelledby="workflow-templates-heading">
            <div className="loop-landing__section-heading">
              <div><FileSearch size={15} aria-hidden="true" /><h2 id="workflow-templates-heading">Workflow templates</h2></div>
            </div>
            <div className="loop-landing__template-list">
              {templates.map((template, index) => {
                const Icon = TEMPLATE_ICONS[index % TEMPLATE_ICONS.length];
                return (
                  <button type="button" className="loop-landing__template-row" key={template.id} onClick={() => onUseTemplate(template)}>
                    <span className="loop-landing__template-icon" aria-hidden="true"><Icon size={15} strokeWidth={1.8} /></span>
                    <span className="loop-landing__template-copy">
                      <span>{template.title}</span>
                      <small>{template.description}</small>
                    </span>
                    <ArrowRight size={14} aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
