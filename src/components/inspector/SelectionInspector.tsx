import { useState, type FormEvent, type ReactNode } from "react";
import { Bot, Database, Eye, EyeOff, GitBranch, KeyRound, Plus, Settings2, Trash2, X } from "lucide-react";
import type {
  AgentNode,
  ContextBlock,
  EnvironmentVariable,
  ObserverRegion,
  Selection,
  Workflow,
  WorkflowEdge,
} from "../../domain/types";
import { AGENT_MODELS, EFFORT_LEVELS, defaultReasoningEffort, effortLabel } from "../../domain/models";
import { SlashAutocompleteTextArea } from "../ui/SlashAutocompleteTextArea";
import "./inspector.css";

export interface SelectionInspectorProps {
  workflow: Workflow;
  selection: Selection;
  onWorkflowChange: (workflow: Workflow) => void;
  onSelectionChange?: (selection: Selection) => void;
}

interface FieldProps {
  label: string;
  hint?: string;
  children: ReactNode;
}

function Field({ label, hint, children }: FieldProps) {
  return (
    <label className="loop-inspector-field">
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="loop-inspector-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function TextInput({ value, onChange, ...props }: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return <input value={value} onChange={(event) => onChange(event.target.value)} {...props} />;
}

function TextArea({ value, onChange, rows = 4, placeholder }: {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  return <textarea value={value} rows={rows} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />;
}

function CheckRow({ checked, label, detail, onChange }: {
  checked: boolean;
  label: string;
  detail?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="loop-check-row">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span><strong>{label}</strong>{detail ? <small>{detail}</small> : null}</span>
    </label>
  );
}

function csv(value: string): string[] {
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function InspectorHeader({ icon, eyebrow, title, onClose }: {
  icon: ReactNode;
  eyebrow: string;
  title: string;
  onClose?: () => void;
}) {
  return (
    <header className="loop-inspector-header">
      <span className="loop-inspector-icon">{icon}</span>
      <div><span>{eyebrow}</span><strong>{title}</strong></div>
      {onClose ? <button type="button" aria-label="Close inspector" title="Close inspector" onClick={onClose}><X size={14} /></button> : null}
    </header>
  );
}

function WorkflowInspector({ workflow, update }: { workflow: Workflow; update: (patch: Partial<Workflow>) => void }) {
  const [tab, setTab] = useState<"settings" | "environment">("settings");
  return (
    <>
      <InspectorHeader icon={<Settings2 size={15} />} eyebrow="Workflow" title={workflow.name} />
      <div className="loop-inspector-tabs" role="tablist" aria-label="Workflow settings">
        <button id="workflow-settings-tab" type="button" role="tab" aria-selected={tab === "settings"} aria-controls="workflow-settings-panel" onClick={() => setTab("settings")}>Settings</button>
        <button id="workflow-environment-tab" type="button" role="tab" aria-selected={tab === "environment"} aria-controls="workflow-environment-panel" onClick={() => setTab("environment")}><KeyRound size={12} aria-hidden="true" /> Environment</button>
      </div>
      {tab === "settings" ? (
        <div className="loop-inspector-scroll" id="workflow-settings-panel" role="tabpanel" aria-labelledby="workflow-settings-tab">
          <Section title="General">
            <Field label="Workflow name"><TextInput value={workflow.name} onChange={(name) => update({ name })} /></Field>
            <Field label="Main task"><TextArea value={workflow.mainTask} rows={5} onChange={(mainTask) => update({ mainTask })} /></Field>
            <Field label="Default model">
              <select value={workflow.defaultModel} onChange={(event) => update({ defaultModel: event.target.value as Workflow["defaultModel"] })}>
                {AGENT_MODELS.map((model) => <option value={model} key={model}>{model}</option>)}
              </select>
            </Field>
          </Section>
          <Section title="Execution">
            <Field label="Execution mode">
              <select value={workflow.executionMode} onChange={(event) => update({ executionMode: event.target.value as Workflow["executionMode"] })}>
                <option value="automatic">Automatic</option><option value="approval-gated">Approval gated</option>
              </select>
            </Field>
            <Field label="Approval policy">
              <select value={workflow.approvalPolicy} onChange={(event) => update({ approvalPolicy: event.target.value as Workflow["approvalPolicy"] })}>
                <option value="never">Never</option><option value="on-risk">On risk</option><option value="every-handoff">Every handoff</option>
              </select>
            </Field>
            <Field label="Maximum retries"><input type="number" min={0} max={10} value={workflow.maximumRetries} onChange={(event) => update({ maximumRetries: event.target.valueAsNumber || 0 })} /></Field>
            <Field label="Shared connectors" hint="Comma-separated"><TextInput value={workflow.sharedConnectors.join(", ")} onChange={(value) => update({ sharedConnectors: csv(value) })} /></Field>
          </Section>
        </div>
      ) : (
        <EnvironmentVariables
          variables={workflow.environmentVariables}
          onChange={(environmentVariables) => update({ environmentVariables })}
        />
      )}
    </>
  );
}

function makeEnvironmentVariableId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `environment-${crypto.randomUUID()}`
    : `environment-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function EnvironmentVariables({ variables, onChange }: {
  variables: EnvironmentVariable[];
  onChange: (variables: EnvironmentVariable[]) => void;
}) {
  const [draftKey, setDraftKey] = useState("");
  const [draftValue, setDraftValue] = useState("");
  const [visibleIds, setVisibleIds] = useState<Set<string>>(() => new Set());
  const normalizedDraftKey = draftKey.trim();
  const duplicateKey = variables.some((variable) => variable.key === normalizedDraftKey);

  const addVariable = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!normalizedDraftKey || duplicateKey) return;
    onChange([...variables, { id: makeEnvironmentVariableId(), key: normalizedDraftKey, value: draftValue }]);
    setDraftKey("");
    setDraftValue("");
  };

  const updateVariable = (id: string, patch: Partial<EnvironmentVariable>) => {
    onChange(variables.map((variable) => variable.id === id ? { ...variable, ...patch } : variable));
  };

  const removeVariable = (id: string) => {
    onChange(variables.filter((variable) => variable.id !== id));
    setVisibleIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };

  const toggleVisible = (id: string) => {
    setVisibleIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="loop-inspector-scroll" id="workflow-environment-panel" role="tabpanel" aria-labelledby="workflow-environment-tab">
      <Section title="Environment values">
        <p className="loop-inspector-note">Add values that every Agent can use as workflow context. Values stay hidden until you reveal them.</p>
        {variables.length ? (
          <div className="loop-environment-list">
            {variables.map((variable) => {
              const visible = visibleIds.has(variable.id);
              return (
                <div className="loop-environment-row" key={variable.id}>
                  <input aria-label={`Environment variable name ${variable.key}`} value={variable.key} onChange={(event) => updateVariable(variable.id, { key: event.target.value })} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                  <div className="loop-environment-value">
                    <input aria-label={`Value for ${variable.key}`} type={visible ? "text" : "password"} value={variable.value} onChange={(event) => updateVariable(variable.id, { value: event.target.value })} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                    <button type="button" className="loop-environment-icon-button" aria-label={`${visible ? "Hide" : "Show"} value for ${variable.key}`} aria-pressed={visible} title={`${visible ? "Hide" : "Show"} value`} onClick={() => toggleVisible(variable.id)}>{visible ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                  </div>
                  <button type="button" className="loop-environment-icon-button" aria-label={`Remove ${variable.key}`} title="Remove variable" onClick={() => removeVariable(variable.id)}><Trash2 size={14} /></button>
                </div>
              );
            })}
          </div>
        ) : <p className="loop-inspector-empty">No environment values yet.</p>}
        <form className="loop-environment-form" onSubmit={addVariable}>
          <Field label="Name"><TextInput value={draftKey} onChange={setDraftKey} placeholder="API_TOKEN" /></Field>
          <Field label="Value"><input type="password" value={draftValue} onChange={(event) => setDraftValue(event.target.value)} placeholder="Enter a value" autoComplete="new-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} /></Field>
          {duplicateKey ? <p className="loop-environment-error" role="alert">That name is already in use.</p> : null}
          <button className="loop-environment-add" type="submit" disabled={!normalizedDraftKey || duplicateKey}><Plus size={14} aria-hidden="true" /> Add variable</button>
        </form>
      </Section>
    </div>
  );
}

function AgentInspector({ workflow, agent, update }: {
  workflow: Workflow;
  agent: AgentNode;
  update: (agent: AgentNode, nextWorkflow?: Workflow) => void;
}) {
  const setContextAccess = (blockId: string, allowed: boolean) => {
    const readableContextBlockIds = allowed
      ? [...new Set([...agent.readableContextBlockIds, blockId])]
      : agent.readableContextBlockIds.filter((id) => id !== blockId);
    const contextBlocks = workflow.contextBlocks.map((block) => block.id === blockId ? {
      ...block,
      allowedAgentNodeIds: allowed
        ? [...new Set([...block.allowedAgentNodeIds, agent.id])]
        : block.allowedAgentNodeIds.filter((id) => id !== agent.id),
    } : block);
    update({ ...agent, readableContextBlockIds }, { ...workflow, contextBlocks });
  };

  return (
    <>
      <InspectorHeader icon={<Bot size={15} />} eyebrow="Agent thread" title={agent.name} />
      <div className="loop-inspector-scroll">
        <Section title="Assignment">
          <Field label="Name"><TextInput value={agent.name} onChange={(name) => update({ ...agent, name })} /></Field>
          <Field label="Role">
            <select value={agent.role} onChange={(event) => update({ ...agent, role: event.target.value as AgentNode["role"] })}>
              <option value="investigator">Investigator</option><option value="implementer">Implementer</option><option value="tester">Tester</option><option value="reviewer">Reviewer</option><option value="custom">Custom</option>
            </select>
          </Field>
          <div className="loop-inspector-field">
            <span>Task</span>
            <SlashAutocompleteTextArea value={agent.task} rows={5} placeholder="Describe the task, or type / for capabilities…" onChange={(task) => update({ ...agent, task })} />
            <small>Type / to add a skill, computer use, or MCP server.</small>
          </div>
          <Field label="Definition of done"><TextArea value={agent.definitionOfDone} rows={4} onChange={(definitionOfDone) => update({ ...agent, definitionOfDone })} /></Field>
        </Section>
        <Section title="Runtime">
          <Field label="Model">
            <select value={agent.configuredModel} onChange={(event) => update({ ...agent, configuredModel: event.target.value as AgentNode["configuredModel"], effectiveModel: event.target.value as AgentNode["effectiveModel"] })}>
              {AGENT_MODELS.map((model) => <option value={model} key={model}>{model}</option>)}
            </select>
          </Field>
          <Field label="Effort level">
            <select value={agent.reasoningEffort ?? defaultReasoningEffort(agent.role)} onChange={(event) => update({ ...agent, reasoningEffort: event.target.value as NonNullable<AgentNode["reasoningEffort"]> })}>
              {EFFORT_LEVELS.map((effort) => <option value={effort} key={effort}>{effortLabel(effort)}</option>)}
            </select>
          </Field>
        </Section>
        <Section title="Context permissions">
          <p className="loop-inspector-note">This Agent receives only the blocks enabled here, not the full workflow history.</p>
          {workflow.contextBlocks.length ? workflow.contextBlocks.map((block) => (
            <CheckRow key={block.id} checked={agent.readableContextBlockIds.includes(block.id)} label={block.title} detail={block.category.replaceAll("-", " ")} onChange={(allowed) => setContextAccess(block.id, allowed)} />
          )) : <p className="loop-inspector-empty">No shared context blocks yet.</p>}
        </Section>
      </div>
    </>
  );
}

function EdgeInspector({ workflow, edge, update }: { workflow: Workflow; edge: WorkflowEdge; update: (edge: WorkflowEdge) => void }) {
  const source = workflow.nodes.find((node) => node.id === edge.source)?.name ?? "Unknown agent";
  const target = workflow.nodes.find((node) => node.id === edge.target)?.name ?? "Unknown agent";
  return (
    <>
      <InspectorHeader icon={<GitBranch size={15} />} eyebrow="Handoff" title={`${source} → ${target}`} />
      <div className="loop-inspector-scroll">
        <Section title="Route">
          <Field label="Source node"><select value={edge.source} onChange={(event) => update({ ...edge, source: event.target.value })}>{workflow.nodes.map((node) => <option value={node.id} key={node.id}>{node.name}</option>)}</select></Field>
          <Field label="Target node"><select value={edge.target} onChange={(event) => update({ ...edge, target: event.target.value })}>{workflow.nodes.map((node) => <option value={node.id} key={node.id}>{node.name}</option>)}</select></Field>
          <Field label="Trigger condition">
            <select value={edge.trigger} onChange={(event) => update({ ...edge, trigger: event.target.value as WorkflowEdge["trigger"] })}>
              <option value="source-completed">Source completed</option><option value="source-settled">Source settled</option><option value="manual-approval">Manual approval</option>
            </select>
          </Field>
          <CheckRow checked={edge.approvalRequired} label="Require user approval" onChange={(approvalRequired) => update({ ...edge, approvalRequired })} />
        </Section>
        <Section title="Context handoff">
          <Field label="Data passed" hint="Comma-separated"><TextArea value={edge.payload.join(", ")} rows={3} onChange={(value) => update({ ...edge, payload: csv(value) })} /></Field>
          <Field label="Edge retries"><input type="number" min={0} max={10} value={edge.retries} onChange={(event) => update({ ...edge, retries: event.target.valueAsNumber || 0 })} /></Field>
          <Field label="Failure behavior">
            <select value={edge.failureBehavior} onChange={(event) => update({ ...edge, failureBehavior: event.target.value as WorkflowEdge["failureBehavior"] })}>
              <option value="block-target">Block target</option><option value="continue-with-warning">Continue with warning</option><option value="ask-user">Ask user</option>
            </select>
          </Field>
        </Section>
      </div>
    </>
  );
}

function ObserverInspector({ workflow, observer, update }: { workflow: Workflow; observer: ObserverRegion; update: (observer: ObserverRegion) => void }) {
  return (
    <>
      <InspectorHeader icon={<Eye size={15} />} eyebrow="Observer region" title={observer.name} />
      <div className="loop-inspector-scroll">
        <Section title="Supervision">
          <Field label="Name"><TextInput value={observer.name} onChange={(name) => update({ ...observer, name })} /></Field>
          <Field label="Instructions"><TextArea value={observer.instructions} rows={5} onChange={(instructions) => update({ ...observer, instructions })} /></Field>
          <Field label="Intervention conditions" hint="Comma-separated"><TextArea value={observer.conditions.join(", ")} rows={3} onChange={(value) => update({ ...observer, conditions: csv(value) })} /></Field>
        </Section>
        <Section title="Covered Agents">
          {workflow.nodes.map((node) => <CheckRow key={node.id} checked={observer.coveredNodeIds.includes(node.id)} label={node.name} detail={node.status} onChange={(checked) => update({ ...observer, coveredNodeIds: checked ? [...new Set([...observer.coveredNodeIds, node.id])] : observer.coveredNodeIds.filter((id) => id !== node.id) })} />)}
        </Section>
        <Section title="Intervention policy">
          <Field label="Extra retries"><input type="number" min={0} max={10} value={observer.extraRetries} onChange={(event) => update({ ...observer, extraRetries: event.target.valueAsNumber || 0 })} /></Field>
          <Field label="Model upgrade">
            <select value={observer.modelUpgradeTo} onChange={(event) => update({ ...observer, modelUpgradeTo: event.target.value as ObserverRegion["modelUpgradeTo"] })}>
              {AGENT_MODELS.map((model) => <option value={model} key={model}>{model}</option>)}
            </select>
          </Field>
          <Field label="Escalation">
            <select value={observer.escalationBehavior} onChange={(event) => update({ ...observer, escalationBehavior: event.target.value as ObserverRegion["escalationBehavior"] })}>
              <option value="pause-workflow">Pause workflow</option><option value="ask-user">Ask user</option><option value="log-and-continue">Log and continue</option>
            </select>
          </Field>
        </Section>
      </div>
    </>
  );
}

function ContextInspector({ workflow, block, update }: { workflow: Workflow; block: ContextBlock; update: (block: ContextBlock, nodes?: AgentNode[]) => void }) {
  const setAgentAccess = (agent: AgentNode, allowed: boolean) => {
    const allowedAgentNodeIds = allowed ? [...new Set([...block.allowedAgentNodeIds, agent.id])] : block.allowedAgentNodeIds.filter((id) => id !== agent.id);
    const nodes = workflow.nodes.map((node) => node.id === agent.id ? {
      ...node,
      readableContextBlockIds: allowed ? [...new Set([...node.readableContextBlockIds, block.id])] : node.readableContextBlockIds.filter((id) => id !== block.id),
    } : node);
    update({ ...block, allowedAgentNodeIds }, nodes);
  };
  return (
    <>
      <InspectorHeader icon={<Database size={15} />} eyebrow="Shared context" title={block.title} />
      <div className="loop-inspector-scroll">
        <Section title="Contents">
          <Field label="Title"><TextInput value={block.title} onChange={(title) => update({ ...block, title })} /></Field>
          <Field label="Summary"><TextArea value={block.summary} rows={6} onChange={(summary) => update({ ...block, summary })} /></Field>
          <Field label="Category">
            <select value={block.category} onChange={(event) => update({ ...block, category: event.target.value as ContextBlock["category"] })}>
              <option value="repository-finding">Repository finding</option><option value="acceptance-criteria">Acceptance criteria</option><option value="changed-files">Changed files</option><option value="test-results">Test results</option><option value="architecture-decision">Architecture decision</option><option value="question">Unresolved question</option><option value="constraint">Constraint</option>
            </select>
          </Field>
          <Field label="Estimated tokens"><input type="number" min={0} value={block.estimatedTokens} onChange={(event) => update({ ...block, estimatedTokens: event.target.valueAsNumber || 0 })} /></Field>
          <div className="loop-inspector-readonly"><span>Created by</span><strong>{block.createdBy}</strong></div>
          <div className="loop-inspector-readonly"><span>Created</span><strong>{new Date(block.createdAt).toLocaleString()}</strong></div>
        </Section>
        <Section title="Agent access">
          <p className="loop-inspector-note">Permission changes are explicit and should also be recorded in workflow activity.</p>
          {workflow.nodes.map((agent) => <CheckRow key={agent.id} checked={block.allowedAgentNodeIds.includes(agent.id)} label={agent.name} detail={agent.role} onChange={(allowed) => setAgentAccess(agent, allowed)} />)}
        </Section>
      </div>
    </>
  );
}

export function SelectionInspector({ workflow, selection, onWorkflowChange, onSelectionChange }: SelectionInspectorProps) {
  const close = onSelectionChange ? () => onSelectionChange({ type: "workflow", id: workflow.id }) : undefined;
  const emit = (next: Workflow) => onWorkflowChange({ ...next, updatedAt: new Date().toISOString() });

  let content: ReactNode;
  if (selection.type === "agent") {
    const agent = workflow.nodes.find((node) => node.id === selection.id);
    content = agent ? <AgentInspector workflow={workflow} agent={agent} update={(nextAgent, base = workflow) => {
      const nodes = base.nodes.map((node) => node.id === nextAgent.id ? nextAgent : node);
      const threads = base.threads.map((thread) => thread.nodeId === nextAgent.id ? {
        ...thread,
        title: nextAgent.name,
        task: nextAgent.task,
        definitionOfDone: nextAgent.definitionOfDone,
        model: nextAgent.configuredModel,
        connectors: nextAgent.connectors,
        status: nextAgent.status,
      } : thread);
      emit({ ...base, nodes, threads });
    }} /> : null;
  } else if (selection.type === "edge") {
    const edge = workflow.edges.find((candidate) => candidate.id === selection.id);
    content = edge ? <EdgeInspector workflow={workflow} edge={edge} update={(next) => emit({ ...workflow, edges: workflow.edges.map((candidate) => candidate.id === next.id ? next : candidate) })} /> : null;
  } else if (selection.type === "observer") {
    const observer = workflow.observers.find((candidate) => candidate.id === selection.id);
    content = observer ? <ObserverInspector workflow={workflow} observer={observer} update={(next) => emit({ ...workflow, observers: workflow.observers.map((candidate) => candidate.id === next.id ? next : candidate) })} /> : null;
  } else if (selection.type === "context") {
    const block = workflow.contextBlocks.find((candidate) => candidate.id === selection.id);
    content = block ? <ContextInspector workflow={workflow} block={block} update={(next, nodes = workflow.nodes) => emit({ ...workflow, nodes, contextBlocks: workflow.contextBlocks.map((candidate) => candidate.id === next.id ? next : candidate) })} /> : null;
  } else {
    content = <WorkflowInspector workflow={workflow} update={(patch) => emit({ ...workflow, ...patch })} />;
  }

  if (!content) content = <WorkflowInspector workflow={workflow} update={(patch) => emit({ ...workflow, ...patch })} />;

  return (
    <aside className="loop-inspector" aria-label="Selection inspector">
      {selection.type !== "workflow" && close ? <button className="loop-inspector-close" type="button" aria-label="Show workflow settings" title="Show workflow settings" onClick={close}><X size={14} /></button> : null}
      {content}
    </aside>
  );
}
