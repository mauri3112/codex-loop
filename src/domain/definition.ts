import type {
  Workflow,
  WorkflowDefinition,
  WorkflowMutation,
  WorkflowValidationIssue,
} from "./types";

const definitionKeys = [
  "name",
  "mainTask",
  "defaultModel",
  "executionMode",
  "sharedConnectors",
  "configurationValues",
  "capabilityBindings",
  "secretRequirements",
  "approvalPolicy",
  "maximumRetries",
  "executionBackend",
  "runConfiguration",
  "budgets",
  "nodes",
  "edges",
  "observers",
  "contextBlocks",
  "viewport",
] as const satisfies ReadonlyArray<keyof WorkflowDefinition>;

export function workflowDefinition(workflow: Workflow): WorkflowDefinition {
  const definition = {} as WorkflowDefinition;
  for (const key of definitionKeys) {
    Object.assign(definition, { [key]: structuredClone(workflow[key]) });
  }
  return definition;
}

export function applyWorkflowDefinition(workflow: Workflow, definition: WorkflowDefinition): void {
  for (const key of definitionKeys) {
    Object.assign(workflow, { [key]: structuredClone(definition[key]) });
  }
}

export function createWorkflowMutation(
  workflow: Workflow,
  after: WorkflowDefinition,
  input: Pick<WorkflowMutation, "actor" | "rationale"> & { baseRevision: number; undoneMutationId?: string },
): WorkflowMutation {
  if (workflow.revision !== input.baseRevision) {
    throw new Error(`Workflow revision conflict: expected ${input.baseRevision}, current revision is ${workflow.revision}`);
  }
  return {
    id: `mutation-${globalThis.crypto.randomUUID()}`,
    baseRevision: input.baseRevision,
    revision: input.baseRevision + 1,
    actor: input.actor,
    rationale: input.rationale.trim() || "Updated the Loop definition",
    before: workflowDefinition(workflow),
    after: structuredClone(after),
    createdAt: new Date().toISOString(),
    undoneMutationId: input.undoneMutationId,
  };
}

export function validateWorkflowDefinition(definition: WorkflowDefinition): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];
  const issue = (value: Omit<WorkflowValidationIssue, "id">) => issues.push({
    id: `validation-${value.code}-${issues.length}`,
    ...value,
  });
  const nodeIds = new Set(definition.nodes.map((node) => node.id));
  const duplicateNodeIds = definition.nodes.filter((node, index) => definition.nodes.findIndex((candidate) => candidate.id === node.id) !== index);
  for (const node of duplicateNodeIds) issue({ severity: "error", code: "duplicate-node", message: `Node id ${node.id} is duplicated.`, nodeId: node.id });

  if (!definition.mainTask.trim()) issue({ severity: "error", code: "missing-objective", message: "Define the Loop objective before publishing." });
  if (!definition.nodes.length) issue({ severity: "error", code: "empty-workflow", message: "Add at least one execution node." });
  if (definition.budgets.maximumConcurrentAgents > definition.budgets.maximumTotalAgents) {
    issue({ severity: "error", code: "invalid-agent-budget", message: "Concurrent-agent budget cannot exceed the total-agent budget." });
  }

  for (const node of definition.nodes) {
    if (!node.task.trim()) issue({ severity: "error", code: "missing-task", message: `${node.name} has no task.`, nodeId: node.id });
    if (!node.definitionOfDone.trim()) issue({ severity: "warning", code: "missing-definition-of-done", message: `${node.name} has no explicit definition of done.`, nodeId: node.id });
    if (node.kind === "loop" && !node.orchestration?.stopCondition?.trim()) issue({ severity: "error", code: "missing-stop-condition", message: `${node.name} needs a stop condition.`, nodeId: node.id });
    if (node.kind === "condition" && !node.orchestration?.conditionExpression?.trim()) issue({ severity: "error", code: "missing-condition", message: `${node.name} needs a routing condition.`, nodeId: node.id });
    if (node.kind === "map" && !node.orchestration?.collectionExpression?.trim()) issue({ severity: "error", code: "missing-collection", message: `${node.name} needs a collection expression.`, nodeId: node.id });
    if (node.kind === "subworkflow" && !node.orchestration?.subworkflowId?.trim()) issue({ severity: "error", code: "missing-subworkflow", message: `${node.name} needs a referenced Loop.`, nodeId: node.id });
  }

  const edgeKeys = new Set<string>();
  for (const edge of definition.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      issue({ severity: "error", code: "orphan-edge", message: "An edge references a node that does not exist.", edgeId: edge.id });
    }
    if (edge.source === edge.target && definition.nodes.find((node) => node.id === edge.source)?.kind !== "loop") {
      issue({ severity: "error", code: "self-edge", message: "Only loop nodes may connect to themselves.", edgeId: edge.id });
    }
    const key = `${edge.source}:${edge.target}`;
    if (edgeKeys.has(key)) issue({ severity: "warning", code: "duplicate-edge", message: "Two edges connect the same nodes.", edgeId: edge.id });
    edgeKeys.add(key);
  }

  const incoming = new Set(definition.edges.map((edge) => edge.target));
  if (definition.nodes.length && definition.nodes.every((node) => incoming.has(node.id))) {
    issue({ severity: "warning", code: "no-entry-node", message: "The Loop has no clear entry node." });
  }

  for (const secret of definition.secretRequirements) {
    if (secret.status === "required") issue({ severity: "warning", code: "secret-setup-required", message: `${secret.key} must be bound before affected nodes can run.` });
  }
  for (const capability of definition.capabilityBindings) {
    if (capability.status !== "available") issue({ severity: "warning", code: "capability-setup-required", message: `${capability.name} is not currently available.` });
  }
  return issues;
}
