import type {
  AgentNode,
  AppData,
  ContextBlock,
  ThreadRecord,
  Workflow,
  WorkflowEdge,
} from "../domain/types.js";
import { createLoopSupervisor } from "../domain/normalize.js";

export const workflowTemplates: AppData["templates"] = [
  {
    id: "fix-failing-ci",
    title: "Investigate and fix a failing CI pipeline",
    description: "Parallelize failure analysis, implementation, verification, and review.",
  },
  {
    id: "implement-review-feature",
    title: "Implement and review a feature",
    description: "Turn a feature request into an implementation with an independent review pass.",
  },
  {
    id: "safe-refactor",
    title: "Refactor a subsystem safely",
    description: "Map dependencies, make focused changes, and verify behavior before review.",
  },
  {
    id: "repository-audit",
    title: "Audit a repository",
    description: "Coordinate architecture, security, quality, and maintainability findings.",
  },
  {
    id: "resolve-pr-feedback",
    title: "Resolve pull-request feedback",
    description: "Triage comments, implement fixes, rerun checks, and prepare an audit summary.",
  },
  {
    id: "plan-implement-test-document",
    title: "Plan, implement, test, and document a change",
    description: "A complete delivery loop with explicit context handoffs and a final review.",
  },
];

export const manualThreads: AppData["manualThreads"] = [
  { id: "thread-manual-api", title: "Review API pagination", status: "completed" },
  { id: "thread-manual-tests", title: "Investigate flaky integration tests", status: "waiting" },
  { id: "thread-manual-docs", title: "Update contributor documentation", status: "idle" },
];

const isoNow = () => new Date().toISOString();

const makeId = (prefix: string) => `${prefix}-${globalThis.crypto.randomUUID()}`;
const defaultRunConfiguration = (): Workflow["runConfiguration"] => ({
  mode: "single",
  schedule: {
    days: [1, 2, 3, 4, 5],
    times: ["09:00"],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  },
  webhook: { token: globalThis.crypto.randomUUID().replace(/-/g, ""), parameters: [] },
});

interface GeneratedWorkflowOptions {
  id?: string;
  name?: string;
  saved?: boolean;
  createdAt?: string;
}

function makeAgent(
  workflowId: string,
  key: string,
  input: Omit<AgentNode, "id" | "threadId" | "status" | "attempt" | "progress">,
): AgentNode {
  return {
    ...input,
    id: `${workflowId}-${key}`,
    threadId: `${workflowId}-thread-${key}`,
    status: "idle",
    attempt: 0,
    progress: 0,
  };
}

function makeThread(node: AgentNode): ThreadRecord {
  return {
    id: node.threadId,
    nodeId: node.id,
    title: node.name,
    task: node.task,
    definitionOfDone: node.definitionOfDone,
    model: node.effectiveModel,
    connectors: [...node.connectors],
    status: "idle",
    codex: { state: "disconnected" },
    messages: [
      {
        id: `${node.threadId}-assignment`,
        role: "system",
        content: `Assigned by Codex Loop: ${node.task}`,
        timestamp: isoNow(),
      },
    ],
    toolCalls: [],
    fileChanges: [],
    attempts: [],
  };
}

export function createGeneratedWorkflow(task: string, options: GeneratedWorkflowOptions = {}): Workflow {
  const workflowId = options.id ?? makeId("loop");
  const createdAt = options.createdAt ?? isoNow();
  const normalizedTask = task.trim() || "Investigate the repository, implement the requested change, and verify it end to end.";

  const investigatorA = makeAgent(workflowId, "investigate-code", {
    name: "Trace the code path",
    role: "investigator",
    task: `Inspect the repository and identify the code paths involved in: ${normalizedTask}`,
    definitionOfDone: "Produce a concise root-cause analysis with concrete files, symbols, and risks.",
    configuredModel: "Luna",
    effectiveModel: "Luna",
    reasoningEffort: "low",
    connectors: ["GitHub"],
    readableContextBlockIds: [`${workflowId}-context-criteria`, `${workflowId}-context-constraints`],
    retryPolicy: { maxAttempts: 2, upgradeModelTo: "Sol" },
    position: { x: 60, y: 110 },
    size: { width: 116, height: 124 },
  });
  const investigatorB = makeAgent(workflowId, "investigate-tests", {
    name: "Map tests and constraints",
    role: "investigator",
    task: "Inspect tests, repository conventions, and acceptance boundaries relevant to the requested change.",
    definitionOfDone: "Identify the verification commands, regression risks, and implementation constraints.",
    configuredModel: "Luna",
    effectiveModel: "Luna",
    reasoningEffort: "medium",
    connectors: ["GitHub"],
    readableContextBlockIds: [`${workflowId}-context-criteria`, `${workflowId}-context-constraints`],
    retryPolicy: { maxAttempts: 2, upgradeModelTo: "Sol" },
    position: { x: 60, y: 340 },
    size: { width: 116, height: 124 },
  });
  const implementer = makeAgent(workflowId, "implement", {
    name: "Implement the change",
    role: "implementer",
    task: `Implement the smallest complete, maintainable solution for: ${normalizedTask}`,
    definitionOfDone: "The requested behavior is implemented, locally verified, and ready for independent testing.",
    configuredModel: "Sol",
    effectiveModel: "Sol",
    reasoningEffort: "high",
    connectors: ["GitHub", "Terminal"],
    readableContextBlockIds: [`${workflowId}-context-criteria`, `${workflowId}-context-constraints`],
    retryPolicy: { maxAttempts: 3, upgradeModelTo: "Sol" },
    position: { x: 390, y: 220 },
    size: { width: 116, height: 124 },
  });
  const tester = makeAgent(workflowId, "test", {
    name: "Verify the result",
    role: "tester",
    task: "Run focused and regression verification, inspect failures, and report exact evidence.",
    definitionOfDone: "Required checks pass and the user-visible behavior is verified without regressions.",
    configuredModel: "Terra",
    effectiveModel: "Terra",
    reasoningEffort: "xhigh",
    connectors: ["Terminal", "Browser"],
    readableContextBlockIds: [`${workflowId}-context-criteria`],
    retryPolicy: { maxAttempts: 2, upgradeModelTo: "Sol" },
    position: { x: 730, y: 100 },
    size: { width: 116, height: 124 },
  });
  const reviewer = makeAgent(workflowId, "review", {
    name: "Review and conclude",
    role: "reviewer",
    task: "Audit the implementation and verification evidence against the original task and definition of done.",
    definitionOfDone: "Produce a final review with completed work, evidence, remaining mocks, and genuine risks.",
    configuredModel: "Sol",
    effectiveModel: "Sol",
    reasoningEffort: "max",
    connectors: ["GitHub"],
    readableContextBlockIds: [`${workflowId}-context-criteria`, `${workflowId}-context-constraints`],
    retryPolicy: { maxAttempts: 2, upgradeModelTo: "Sol" },
    position: { x: 730, y: 360 },
    size: { width: 116, height: 124 },
  });
  const nodes = [investigatorA, investigatorB, implementer, tester, reviewer];

  const edge = (key: string, source: AgentNode, target: AgentNode, payload: string[]): WorkflowEdge => ({
    id: `${workflowId}-edge-${key}`,
    source: source.id,
    target: target.id,
    trigger: "source-completed",
    payload,
    retries: 0,
    failureBehavior: "block-target",
    approvalRequired: false,
    status: "idle",
  });

  const contextBlocks: ContextBlock[] = [
    {
      id: `${workflowId}-context-criteria`,
      title: "Acceptance criteria",
      summary: "Complete the requested repository change, verify the full flow, and preserve working behavior.",
      category: "acceptance-criteria",
      createdBy: "manual",
      allowedAgentNodeIds: nodes.map((node) => node.id),
      estimatedTokens: 180,
      createdAt,
      position: { x: 60, y: 560 },
    },
    {
      id: `${workflowId}-context-constraints`,
      title: "Implementation constraints",
      summary: "Keep changes scoped, follow repository conventions, and record exact validation evidence.",
      category: "constraint",
      createdBy: "system",
      allowedAgentNodeIds: [investigatorA.id, investigatorB.id, implementer.id, reviewer.id],
      estimatedTokens: 126,
      createdAt,
      position: { x: 330, y: 560 },
    },
  ];

  return {
    id: workflowId,
    name: options.name ?? "Repository change loop",
    mainTask: normalizedTask,
    defaultModel: "Terra",
    executionMode: "automatic",
    sharedConnectors: ["GitHub", "Terminal", "Browser"],
    environmentVariables: [],
    approvalPolicy: "on-risk",
    maximumRetries: 3,
    executionBackend: "codex",
    runConfiguration: defaultRunConfiguration(),
    status: "ready",
    saved: options.saved ?? false,
    nodes,
    edges: [
      edge("code-to-implement", investigatorA, implementer, ["summary", "repository findings"]),
      edge("tests-to-implement", investigatorB, implementer, ["summary", "test constraints"]),
      edge("implement-to-test", implementer, tester, ["changed files", "implementation summary"]),
      edge("test-to-review", tester, reviewer, ["test results", "final output"]),
    ],
    observers: [createLoopSupervisor(nodes, {
      id: `${workflowId}-supervisor`,
      name: "Loop supervisor",
      instructions: "Track loop health, detect stalled or failed work, and coordinate recovery without taking over agent tasks.",
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      coveredNodeIds: nodes.map((node) => node.id),
      conditions: ["node-failed", "insufficient-model", "retry-limit-near"],
      extraRetries: 1,
      modelUpgradeTo: "Sol",
      escalationBehavior: "ask-user",
      status: "watching",
    })],
    contextBlocks,
    threads: nodes.map(makeThread),
    runs: [],
    events: [],
    viewport: { x: 18, y: 52, zoom: 0.78 },
    createdAt,
    updatedAt: createdAt,
  };
}

export function createBlankWorkflow(): Workflow {
  const now = isoNow();
  return {
    id: makeId("loop"),
    name: "Untitled Loop",
    mainTask: "",
    defaultModel: "Terra",
    executionMode: "automatic",
    sharedConnectors: [],
    environmentVariables: [],
    approvalPolicy: "on-risk",
    maximumRetries: 2,
    executionBackend: "codex",
    runConfiguration: defaultRunConfiguration(),
    status: "draft",
    saved: false,
    nodes: [],
    edges: [],
    observers: [createLoopSupervisor([])],
    contextBlocks: [],
    threads: [],
    runs: [],
    events: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: now,
    updatedAt: now,
  };
}

export function createInitialData(): AppData {
  const seed = createGeneratedWorkflow(
    "Investigate a failing repository change, implement a robust fix, run the full verification flow, and complete an independent review.",
    {
      id: "loop-repository-change-demo",
      name: "Repository change delivery",
      saved: true,
      createdAt: "2026-07-16T08:00:00.000Z",
    },
  );

  return {
    workflows: [seed],
    templates: workflowTemplates.map((template) => ({ ...template })),
    manualThreads: manualThreads.map((thread) => ({ ...thread })),
  };
}
