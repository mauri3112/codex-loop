import { memo } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import type { LoopFlowEdge } from "./types";

function WorkflowEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  selected,
  data,
}: EdgeProps<LoopFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.34,
  });
  const status = data?.edge.status ?? "idle";

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className={`loop-edge-path loop-edge-${status}${selected ? " is-selected" : ""}`}
      />
      {data?.edge.approvalRequired || status !== "idle" ? (
        <EdgeLabelRenderer>
          <div
            className={`loop-edge-label loop-edge-label-${status} nopan nodrag`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {status === "waiting-approval" ? "Approval" : status.replace("-", " ")}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const WorkflowCanvasEdge = memo(WorkflowEdgeView);
