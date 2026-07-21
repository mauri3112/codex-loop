export type SimulationCheckStatus = "pass" | "warning" | "fail";

export interface SimulationCheck {
  id: string;
  category: "workflow" | "workspace" | "capability" | "secret" | "runtime";
  status: SimulationCheckStatus;
  label: string;
  detail: string;
  nodeIds?: string[];
}

export interface SimulatedThreadStep {
  sequence: number;
  stage: number;
  nodeId: string;
  nodeName: string;
  kind: string;
  status: "would-run" | "would-wait" | "blocked";
  dependsOn: string[];
  requiredCapabilities: string[];
  procedure: string[];
  possibleOutput: string;
}

export interface WorkflowSimulationReport {
  id: string;
  workflowId: string;
  workflowRevision: number;
  generatedAt: string;
  readOnly: true;
  status: "sound" | "needs-attention" | "blocked";
  canRun: boolean;
  summary: string;
  workingDirectory: string;
  checks: SimulationCheck[];
  steps: SimulatedThreadStep[];
  possibleFinalOutput: string;
}

export interface SimulationOptions {
  workingDirectory?: string;
}
