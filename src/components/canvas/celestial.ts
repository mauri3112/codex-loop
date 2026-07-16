import type { AgentNode } from "../../domain/types";
export { defaultReasoningEffort, effortLabel } from "../../domain/models";

export type CelestialBody = "sol" | "terra" | "luna";

export interface CelestialVisual {
  body: CelestialBody;
  label: "Sol" | "Terra" | "Luna";
  asset: string;
}

const visuals: Record<CelestialBody, CelestialVisual> = {
  sol: { body: "sol", label: "Sol", asset: "/assets/celestial/sol.png" },
  terra: { body: "terra", label: "Terra", asset: "/assets/celestial/terra.png" },
  luna: { body: "luna", label: "Luna", asset: "/assets/celestial/luna.png" },
};

export function celestialVisualFor(agent: AgentNode): CelestialVisual {
  const model = agent.effectiveModel.toLowerCase();
  if (model.includes("sol")) return visuals.sol;
  if (model.includes("terra")) return visuals.terra;
  if (model.includes("luna")) return visuals.luna;

  if (agent.role === "implementer" || agent.role === "reviewer") return visuals.sol;
  if (agent.role === "tester") return visuals.terra;
  return visuals.luna;
}
