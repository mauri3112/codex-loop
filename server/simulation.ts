import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { validateWorkflowDefinition, workflowDefinition } from "../src/domain/definition.js";
import type {
  SimulatedThreadStep,
  SimulationCheck,
  SimulationOptions,
  WorkflowSimulationReport,
} from "../src/domain/simulation-report.js";
import type { AgentNode, CapabilityBinding, SecretRequirement, Workflow } from "../src/domain/types.js";
import type { TaskCapabilitiesResponse, TaskCapability } from "../src/domain/task-capabilities.js";

export interface SimulationCapabilityProbe {
  listTaskCapabilities?(workingDirectory?: string): Promise<TaskCapabilitiesResponse>;
}

interface GraphPlan {
  stages: string[][];
  cyclicNodeIds: Set<string>;
}

const BUILT_IN_CONNECTORS = new Set(["filesystem", "git", "repository", "shell", "terminal", "test runner", "tests"]);

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function short(value: string, limit = 180): string {
  const compact = value.trim().replace(/\s+/g, " ");
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
}

function clause(value: string, limit = 180): string {
  return short(value, limit).replace(/[.!?]+$/, "");
}

function graphPlan(workflow: Workflow): GraphPlan {
  const nodeIds = new Set(workflow.nodes.map((node) => node.id));
  const incoming = new Map(workflow.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(workflow.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of workflow.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target) || edge.source === edge.target) continue;
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }

  const stages: string[][] = [];
  const visited = new Set<string>();
  let ready = workflow.nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
  while (ready.length) {
    const stage = [...ready];
    stages.push(stage);
    ready = [];
    for (const nodeId of stage) {
      visited.add(nodeId);
      for (const targetId of outgoing.get(nodeId) ?? []) {
        const remaining = (incoming.get(targetId) ?? 1) - 1;
        incoming.set(targetId, remaining);
        if (remaining === 0) ready.push(targetId);
      }
    }
  }
  return { stages, cyclicNodeIds: new Set(workflow.nodes.filter((node) => !visited.has(node.id)).map((node) => node.id)) };
}

function capabilityMatch(binding: CapabilityBinding, inventory: TaskCapability[]): TaskCapability | undefined {
  const bindingName = normalize(binding.name);
  return inventory.find((item) => item.id === binding.id)
    ?? inventory.find((item) => item.kind === binding.kind && normalize(item.label) === bindingName)
    ?? inventory.find((item) => normalize(item.label) === bindingName);
}

function connectorMatch(name: string, inventory: TaskCapability[]): TaskCapability | undefined {
  const connector = normalize(name);
  return inventory.find((item) => normalize(item.label) === connector || normalize(item.id.split(":").at(-1) ?? "") === connector);
}

function procedureFor(node: AgentNode, dependencies: AgentNode[], capabilities: string[]): string[] {
  if (node.kind === "gate") {
    return [
      `Would pause at the approval gate “${node.name}”.`,
      "Would present the upstream evidence and wait for an explicit approve or decline decision.",
      "Would release downstream nodes only after approval.",
    ];
  }
  if (node.kind === "subworkflow") {
    return [
      `Would resolve the published subworkflow ${node.orchestration?.subworkflowId ?? "(missing id)"}.`,
      `Would pass ${dependencies.length ? dependencies.map((item) => item.name).join(", ") : "the Loop objective"} as bounded context.`,
      "Would wait for the child Loop result and return only its final summary downstream.",
    ];
  }

  const steps = [
    `Would create an isolated ${node.configuredModel} Codex thread for “${node.name}” (no thread was created by this simulation).`,
    dependencies.length
      ? `Would provide summaries from ${dependencies.map((item) => item.name).join(", ")}.`
      : "Would provide the Loop objective as the initial context.",
    capabilities.length
      ? `Would expose only the declared capabilities: ${capabilities.join(", ")}.`
      : "Would use the configured workspace without any additional declared capability.",
    `Would perform the task: ${clause(node.task)}.`,
  ];

  if (node.kind === "map") steps.push(`Would fan out over ${node.orchestration?.collectionExpression ?? "the configured collection"} within the agent budgets.`);
  if (node.kind === "condition") steps.push(`Would evaluate ${node.orchestration?.conditionExpression ?? "the configured condition"} and activate only the matching branch.`);
  if (node.kind === "loop") steps.push(`Would iterate until ${node.orchestration?.stopCondition ?? "the stop condition"}, capped at ${node.orchestration?.maximumIterations ?? "the Loop budget"}.`);
  if (node.kind === "join") steps.push("Would wait for all required upstream branches and merge their evidence without exposing full thread histories.");
  if (node.kind === "verify") steps.push(`Would grade the evidence against ${clause(node.orchestration?.verificationRubric ?? (node.definitionOfDone || "the definition of done"))}.`);
  steps.push(`Would verify completion against: ${clause(node.definitionOfDone || "the node task")}.`);
  steps.push("Would return a concise result and evidence summary for downstream nodes.");
  return steps;
}

function possibleOutputFor(node: AgentNode): string {
  const target = short(node.definitionOfDone || node.task, 150);
  if (node.kind === "gate") return `Approval requested for ${node.name}, with the relevant upstream evidence attached.`;
  if (node.kind === "condition") return `Condition evaluated; the matching route would be selected with the decision evidence recorded.`;
  if (node.kind === "join") return `Merged the required upstream results into one consistent evidence summary. ${target}`;
  if (node.kind === "verify") return `Verification would report pass or fail with exact evidence for: ${target}`;
  if (node.kind === "loop") return `Iteration would stop when the configured condition is met, with the final state summarized. ${target}`;
  if (node.kind === "map") return `Each collection item would produce a bounded result, followed by a synthesized summary. ${target}`;
  if (node.kind === "subworkflow") return `The referenced Loop would return its final status and evidence summary. ${target}`;
  return `Likely result: ${clause(node.task, 120)} completed, with concrete evidence showing ${target.charAt(0).toLocaleLowerCase()}${target.slice(1)}`;
}

function addCapabilityChecks(
  workflow: Workflow,
  inventory: TaskCapability[],
  inventoryAvailable: boolean,
  checks: SimulationCheck[],
): Map<string, string[]> {
  const requiredByNode = new Map<string, string[]>();
  for (const binding of workflow.capabilityBindings) {
    for (const nodeId of binding.requiredByNodeIds) {
      const current = requiredByNode.get(nodeId) ?? [];
      current.push(binding.name);
      requiredByNode.set(nodeId, current);
    }
    const live = capabilityMatch(binding, inventory);
    let status: SimulationCheck["status"] = "pass";
    let detail = `${binding.name} is available for ${binding.requiredByNodeIds.length || "all"} affected node(s).`;
    if (binding.status !== "available") {
      status = "fail";
      detail = `${binding.name} is marked ${binding.status}; affected threads could not start.`;
    } else if (inventoryAvailable && !live) {
      status = "fail";
      detail = `${binding.name} is configured but was not found in the live Codex capability inventory.`;
    } else if (live && !live.available) {
      status = "fail";
      detail = `${binding.name} is present but unavailable${live.authStatus === "notLoggedIn" ? " because authentication is missing" : ""}.`;
    } else if (live?.authStatus === "unknown" || live?.authStatus === "unsupported") {
      status = "warning";
      detail = `${binding.name} is present, but its authentication state cannot be verified automatically.`;
    } else if (!inventoryAvailable) {
      status = "warning";
      detail = `${binding.name} is marked available, but the live capability inventory could not be checked.`;
    } else if (live?.authStatus) {
      detail = `${binding.name} is available; authentication status is ${live.authStatus}.`;
    }
    checks.push({ id: `capability-${binding.id}`, category: "capability", status, label: binding.name, detail, nodeIds: binding.requiredByNodeIds });
  }

  const declaredNames = new Set(workflow.capabilityBindings.map((binding) => normalize(binding.name)));
  const connectorNames = new Set([...workflow.sharedConnectors, ...workflow.nodes.flatMap((node) => node.connectors)].filter(Boolean));
  for (const name of Array.from(connectorNames)) {
    if (declaredNames.has(normalize(name))) continue;
    const live = connectorMatch(name, inventory);
    const builtIn = BUILT_IN_CONNECTORS.has(normalize(name));
    checks.push({
      id: `connector-${normalize(name).replace(/ /g, "-")}`,
      category: "capability",
      status: builtIn || live?.available ? "pass" : "warning",
      label: name,
      detail: builtIn
        ? `${name} is satisfied by read-only workspace and shell access.`
        : live?.available
          ? `${name} is available in the live Codex inventory${live.authStatus ? ` with ${live.authStatus} authentication` : ""}.`
          : `${name} is a legacy connector label without a verified capability binding.`,
    });
  }
  if (!workflow.capabilityBindings.length && !connectorNames.size) {
    checks.push({ id: "capabilities-none", category: "capability", status: "pass", label: "Additional capabilities", detail: "No external capabilities are required by this Loop." });
  }
  return requiredByNode;
}

function addSecretChecks(workflow: Workflow, inventory: TaskCapability[], checks: SimulationCheck[]): void {
  if (!workflow.secretRequirements.length) {
    checks.push({ id: "secrets-none", category: "secret", status: "pass", label: "Secrets", detail: "No secrets are required by this Loop." });
    return;
  }
  for (const secret of workflow.secretRequirements) {
    let status: SimulationCheck["status"] = "pass";
    let detail = `${secret.key} is bound; its value was not read or returned.`;
    if (secret.status !== "bound") {
      status = "fail";
      detail = `${secret.key} is still required and would block affected threads.`;
    } else if (secret.source === "process-env") {
      const environmentKey = secret.sourceRef?.trim() || secret.key;
      const present = Object.prototype.hasOwnProperty.call(process.env, environmentKey) && Boolean(process.env[environmentKey]);
      status = present ? "pass" : "fail";
      detail = present
        ? `${environmentKey} is present in the runtime environment; its value was not read or returned.`
        : `${environmentKey} is not present in the runtime environment.`;
    } else if (secret.source === "connector") {
      const live = inventory.find((item) => item.id === secret.sourceRef || normalize(item.label) === normalize(secret.sourceRef ?? ""));
      if (!live) {
        status = "warning";
        detail = `${secret.key} is bound to a connector, but that connector could not be verified live.`;
      } else if (!live.available) {
        status = "fail";
        detail = `${secret.key} is bound to ${live.label}, but that connector is not authenticated or enabled.`;
      } else {
        detail = `${secret.key} is bound through ${live.label}; authentication is ${live.authStatus ?? "available"}.`;
      }
    } else if (secret.source === "keychain") {
      status = "warning";
      detail = `${secret.key} has a keychain binding, but simulation intentionally did not read the credential.`;
    } else if (secret.status === "bound") {
      status = "warning";
      detail = `${secret.key} is marked bound, but no verifiable source is recorded.`;
    }
    checks.push({ id: `secret-${secret.id}`, category: "secret", status, label: secret.key, detail, nodeIds: secret.requiredByNodeIds });
  }
}

function nodeIsBlocked(node: AgentNode, checks: SimulationCheck[]): boolean {
  return checks.some((check) => check.status === "fail" && (!check.nodeIds?.length || check.nodeIds.includes(node.id)));
}

export async function simulateWorkflow(
  workflow: Workflow,
  capabilityProbe: SimulationCapabilityProbe,
  options: SimulationOptions = {},
): Promise<WorkflowSimulationReport> {
  const generatedAt = new Date().toISOString();
  const checks: SimulationCheck[] = [];
  const workingDirectory = path.resolve(options.workingDirectory?.trim() || process.env.CODEX_LOOP_WORKSPACE || process.cwd());

  const validationIssues = validateWorkflowDefinition(workflowDefinition(workflow));
  if (!validationIssues.length) {
    checks.push({ id: "workflow-valid", category: "workflow", status: "pass", label: "Workflow definition", detail: "The workflow definition has no validation issues." });
  } else {
    checks.push(...validationIssues.map((issue) => ({
      id: issue.id,
      category: "workflow" as const,
      status: issue.severity === "error" ? "fail" as const : "warning" as const,
      label: issue.code.replace(/-/g, " "),
      detail: issue.message,
      ...(issue.nodeId ? { nodeIds: [issue.nodeId] } : {}),
    })));
  }

  try {
    const info = await stat(workingDirectory);
    if (!info.isDirectory()) throw new Error("Path is not a directory");
    await access(workingDirectory, fsConstants.R_OK);
    checks.push({ id: "workspace-readable", category: "workspace", status: "pass", label: "Workspace access", detail: `${workingDirectory} exists and is readable. No files were listed or changed.` });
  } catch (error) {
    checks.push({ id: "workspace-readable", category: "workspace", status: "fail", label: "Workspace access", detail: `${workingDirectory} is not a readable directory: ${error instanceof Error ? error.message : "access failed"}.` });
  }

  let inventory: TaskCapability[] = [];
  let inventoryAvailable = false;
  if (capabilityProbe.listTaskCapabilities) {
    try {
      const response = await capabilityProbe.listTaskCapabilities(workingDirectory);
      inventory = response.items;
      inventoryAvailable = true;
      checks.push({ id: "runtime-inventory", category: "runtime", status: response.warnings?.length ? "warning" : "pass", label: "Codex access probe", detail: response.warnings?.length ? response.warnings.join(" ") : `Read-only inventory returned ${inventory.length} available capability record(s).` });
    } catch (error) {
      checks.push({ id: "runtime-inventory", category: "runtime", status: "warning", label: "Codex access probe", detail: `Live capability and authentication checks were unavailable: ${error instanceof Error ? error.message : "probe failed"}. No worker thread was started.` });
    }
  } else {
    checks.push({ id: "runtime-inventory", category: "runtime", status: "warning", label: "Codex access probe", detail: "This runtime cannot list capabilities, so live authentication could not be verified." });
  }

  const requiredByNode = addCapabilityChecks(workflow, inventory, inventoryAvailable, checks);
  addSecretChecks(workflow, inventory, checks);

  const plan = graphPlan(workflow);
  if (plan.cyclicNodeIds.size) {
    checks.push({ id: "graph-cycle", category: "workflow", status: "fail", label: "Dependency order", detail: `No safe execution order exists for: ${workflow.nodes.filter((node) => plan.cyclicNodeIds.has(node.id)).map((node) => node.name).join(", ")}.`, nodeIds: Array.from(plan.cyclicNodeIds) });
  } else {
    checks.push({ id: "graph-order", category: "workflow", status: "pass", label: "Dependency order", detail: `${workflow.nodes.length} node(s) resolve into ${plan.stages.length} execution stage(s).` });
  }
  if (workflow.nodes.length > workflow.budgets.maximumTotalAgents) {
    checks.push({ id: "agent-budget", category: "workflow", status: "fail", label: "Agent budget", detail: `${workflow.nodes.length} nodes exceed the maximum total-agent budget of ${workflow.budgets.maximumTotalAgents}.` });
  } else {
    const widestStage = Math.max(0, ...plan.stages.map((stage) => stage.length));
    checks.push({ id: "agent-budget", category: "workflow", status: widestStage > workflow.budgets.maximumConcurrentAgents ? "warning" : "pass", label: "Agent budget", detail: widestStage > workflow.budgets.maximumConcurrentAgents ? `The widest stage has ${widestStage} nodes and would run in batches of ${workflow.budgets.maximumConcurrentAgents}.` : `The plan fits the ${workflow.budgets.maximumConcurrentAgents}-concurrent / ${workflow.budgets.maximumTotalAgents}-total agent budget.` });
  }
  const unboundedNodes = workflow.nodes.filter((node) => node.kind === "map" || node.kind === "loop");
  if (unboundedNodes.length) {
    checks.push({ id: "dynamic-expansion", category: "workflow", status: "warning", label: "Dynamic expansion", detail: `${unboundedNodes.map((node) => node.name).join(", ")} may consume additional iterations or agents; runtime budgets would remain enforced.`, nodeIds: unboundedNodes.map((node) => node.id) });
  }

  const stageByNode = new Map(plan.stages.flatMap((stage, index) => stage.map((nodeId) => [nodeId, index + 1] as const)));
  for (const nodeId of Array.from(plan.cyclicNodeIds)) stageByNode.set(nodeId, plan.stages.length + 1);
  const orderedNodes = [...workflow.nodes].sort((left, right) => (stageByNode.get(left.id) ?? 0) - (stageByNode.get(right.id) ?? 0));
  const steps: SimulatedThreadStep[] = orderedNodes.map((node, index) => {
    const dependencies = workflow.edges.filter((edge) => edge.target === node.id && edge.source !== edge.target).map((edge) => workflow.nodes.find((candidate) => candidate.id === edge.source)).filter((candidate): candidate is AgentNode => Boolean(candidate));
    const capabilities = Array.from(new Set([...(requiredByNode.get(node.id) ?? []), ...node.connectors]));
    return {
      sequence: index + 1,
      stage: stageByNode.get(node.id) ?? 1,
      nodeId: node.id,
      nodeName: node.name,
      kind: node.kind,
      status: nodeIsBlocked(node, checks) || plan.cyclicNodeIds.has(node.id) ? "blocked" : node.kind === "gate" ? "would-wait" : "would-run",
      dependsOn: dependencies.map((item) => item.name),
      requiredCapabilities: capabilities,
      procedure: procedureFor(node, dependencies, capabilities),
      possibleOutput: possibleOutputFor(node),
    };
  });

  const failures = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warning").length;
  const status = failures ? "blocked" : warnings ? "needs-attention" : "sound";
  const terminalNodes = workflow.nodes.filter((node) => !workflow.edges.some((edge) => edge.source === node.id && edge.source !== edge.target));
  return {
    id: `simulation-${globalThis.crypto.randomUUID()}`,
    workflowId: workflow.id,
    workflowRevision: workflow.revision,
    generatedAt,
    readOnly: true,
    status,
    canRun: failures === 0,
    summary: failures
      ? `${failures} blocking check(s) must be resolved before this Loop is likely to complete.`
      : warnings
        ? `The Loop has a valid execution path with ${warnings} item(s) worth reviewing.`
        : `The Loop has a sound ${plan.stages.length}-stage execution path and the required access checks passed.`,
    workingDirectory,
    checks,
    steps,
    possibleFinalOutput: terminalNodes.length
      ? `Possible final result: ${terminalNodes.map((node) => possibleOutputFor(node)).join(" ")}`
      : "No final output can be projected because the Loop has no terminal node.",
  };
}
