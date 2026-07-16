import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Bot, Eye, Link2, Maximize2, Minus, Plus, Settings2, X } from "lucide-react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnConnect,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {
  AgentNode,
  ObserverRegion,
  Rect,
  Selection,
  ThreadRecord,
  Workflow,
  WorkflowEdge,
} from "../../domain/types";
import { COMPACT_AGENT_SIZE, createLoopSupervisor } from "../../domain/normalize";
import { SelectionInspector } from "../inspector/SelectionInspector";
import { AgentCanvasNode, ContextCanvasNode, ObserverCanvasNode } from "./CanvasNodes";
import { WorkflowCanvasEdge } from "./WorkflowEdge";
import {
  flowId,
  parseFlowId,
  type LoopFlowEdge,
  type LoopFlowNode,
} from "./types";
import "./canvas.css";

const nodeTypes = {
  agent: AgentCanvasNode,
  context: ContextCanvasNode,
  observer: ObserverCanvasNode,
};

const edgeTypes = { workflow: WorkflowCanvasEdge };

export interface LoopWorkspaceCanvasProps {
  workflow: Workflow;
  selection?: Selection | null;
  onSelectionChange: (selection: Selection) => void;
  onWorkflowChange: (workflow: Workflow) => void;
  onOpenThread?: (threadId: string) => void;
  className?: string;
}

interface DrawStart {
  clientX: number;
  clientY: number;
  flowX: number;
  flowY: number;
}

interface DrawPreview {
  left: number;
  top: number;
  width: number;
  height: number;
}

function createId(prefix: string): string {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function coveredNodes(nodes: AgentNode[], bounds: Rect): string[] {
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  return nodes.flatMap((node) => {
    const centerX = node.position.x + COMPACT_AGENT_SIZE.width / 2;
    const centerY = node.position.y + COMPACT_AGENT_SIZE.height / 2;
    return centerX >= bounds.x && centerX <= right && centerY >= bounds.y && centerY <= bottom ? [node.id] : [];
  });
}

function withObserverMembership(workflow: Workflow, nodes: AgentNode[]): ObserverRegion[] {
  return [createLoopSupervisor(nodes, workflow.observers[0])];
}

function defaultAgent(position: { x: number; y: number }): { agent: AgentNode; thread: ThreadRecord } {
  const id = createId("agent");
  const threadId = createId("thread");
  const agent: AgentNode = {
    id,
    threadId,
    name: "New agent",
    role: "custom",
    task: "",
    definitionOfDone: "",
    configuredModel: "Terra",
    effectiveModel: "Terra",
    reasoningEffort: "medium",
    connectors: [],
    readableContextBlockIds: [],
    retryPolicy: { maxAttempts: 2, upgradeModelTo: "Sol" },
    status: "idle",
    attempt: 0,
    progress: 0,
    position,
    size: COMPACT_AGENT_SIZE,
  };
  return {
    agent,
    thread: {
      id: threadId,
      nodeId: id,
      title: agent.name,
      task: agent.task,
      definitionOfDone: agent.definitionOfDone,
      model: agent.configuredModel,
      connectors: [],
      status: "idle",
      messages: [],
      toolCalls: [],
      fileChanges: [],
      attempts: [],
    },
  };
}

function LoopWorkspaceCanvasInner({
  workflow,
  selection,
  onSelectionChange,
  onWorkflowChange,
  onOpenThread,
  className,
}: LoopWorkspaceCanvasProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const drawStartRef = useRef<DrawStart | null>(null);
  const [observerDrawMode, setObserverDrawMode] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [connectSource, setConnectSource] = useState(workflow.nodes[0]?.id ?? "");
  const [connectTarget, setConnectTarget] = useState(workflow.nodes[1]?.id ?? "");
  const [drawPreview, setDrawPreview] = useState<DrawPreview | null>(null);
  const { screenToFlowPosition, zoomIn, zoomOut, fitView } = useReactFlow<LoopFlowNode, LoopFlowEdge>();

  const emit = useCallback((next: Workflow) => {
    onWorkflowChange({ ...next, updatedAt: new Date().toISOString() });
  }, [onWorkflowChange]);

  const mappedNodes = useMemo<LoopFlowNode[]>(() => [
    ...workflow.observers.map<LoopFlowNode>((observer) => ({
      id: flowId.observer(observer.id),
      type: "observer",
      position: { x: observer.bounds.x, y: observer.bounds.y },
      style: { width: observer.bounds.width, height: observer.bounds.height },
      data: {
        kind: "observer",
        observer,
      },
      draggable: false,
      selected: selection?.type === "observer" && selection.id === observer.id,
      zIndex: -2,
      ariaLabel: `Observer region ${observer.name}`,
    })),
    ...workflow.nodes.map<LoopFlowNode>((agent, index) => ({
      id: flowId.agent(agent.id),
      type: "agent",
      position: agent.position,
      style: COMPACT_AGENT_SIZE,
      data: {
        kind: "agent",
        agent,
        order: index + 1,
        onOpenThread,
      },
      selected: selection?.type === "agent" && selection.id === agent.id,
      zIndex: 2,
      ariaLabel: `Agent ${agent.name}, ${agent.status}`,
    })),
  ], [onOpenThread, selection, workflow.nodes, workflow.observers]);

  const mappedEdges = useMemo<LoopFlowEdge[]>(() => workflow.edges.map((edge) => ({
    id: flowId.edge(edge.id),
    type: "workflow",
    source: flowId.agent(edge.source),
    target: flowId.agent(edge.target),
    data: { edge },
    selected: selection?.type === "edge" && selection.id === edge.id,
    animated: edge.status === "active",
    markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color: "var(--faint)" },
    zIndex: 1,
  })), [selection, workflow.edges]);

  const [nodes, setNodes] = useNodesState<LoopFlowNode>(mappedNodes);
  const [edges, setEdges] = useEdgesState<LoopFlowEdge>(mappedEdges);

  useEffect(() => setNodes(mappedNodes), [mappedNodes, setNodes]);
  useEffect(() => setEdges(mappedEdges), [mappedEdges, setEdges]);

  const onNodesChange = useCallback((changes: NodeChange<LoopFlowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, [setNodes]);

  const onEdgesChange = useCallback((changes: EdgeChange<LoopFlowEdge>[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  }, [setEdges]);

  const addAgent = useCallback((position: { x: number; y: number }) => {
    const created = defaultAgent(position);
    const nodes = [...workflow.nodes, created.agent];
    emit({ ...workflow, nodes, observers: withObserverMembership(workflow, nodes), threads: [...workflow.threads, created.thread] });
    onSelectionChange({ type: "agent", id: created.agent.id });
    setMobileInspectorOpen(true);
  }, [emit, onSelectionChange, workflow]);

  const connectNodes = useCallback((sourceId: string, targetId: string) => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    if (workflow.edges.some((edge) => edge.source === sourceId && edge.target === targetId)) return;
    const edge: WorkflowEdge = {
      id: createId("edge"),
      source: sourceId,
      target: targetId,
      trigger: "source-completed",
      payload: ["final-output"],
      retries: 0,
      failureBehavior: "block-target",
      approvalRequired: false,
      status: "idle",
    };
    emit({ ...workflow, edges: [...workflow.edges, edge] });
    onSelectionChange({ type: "edge", id: edge.id });
    setMobileInspectorOpen(true);
    setConnectOpen(false);
  }, [emit, onSelectionChange, workflow]);

  const onConnect: OnConnect = useCallback((connection: Connection) => {
    const source = connection.source ? parseFlowId(connection.source) : null;
    const target = connection.target ? parseFlowId(connection.target) : null;
    if (!source || !target || source.kind !== "agent" || target.kind !== "agent") return;
    connectNodes(source.id, target.id);
  }, [connectNodes]);

  const handleNodeDragStop = useCallback((_event: MouseEvent | TouchEvent, flowNode: LoopFlowNode) => {
    const parsed = parseFlowId(flowNode.id);
    if (!parsed) return;
    if (parsed.kind === "agent") {
      const updatedNodes = workflow.nodes.map((node) => node.id === parsed.id ? { ...node, position: flowNode.position } : node);
      emit({ ...workflow, nodes: updatedNodes, observers: withObserverMembership(workflow, updatedNodes) });
    } else if (parsed.kind === "context") {
      emit({
        ...workflow,
        contextBlocks: workflow.contextBlocks.map((block) => block.id === parsed.id ? { ...block, position: flowNode.position } : block),
      });
    }
  }, [emit, workflow]);

  const handleRootDoubleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (observerDrawMode || !(event.target instanceof Element) || !event.target.classList.contains("react-flow__pane")) return;
    addAgent(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }, [addAgent, observerDrawMode, screenToFlowPosition]);

  const beginObserverDraw = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const flow = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    drawStartRef.current = { clientX: event.clientX, clientY: event.clientY, flowX: flow.x, flowY: flow.y };
    setDrawPreview({ left: event.clientX, top: event.clientY, width: 0, height: 0 });
  }, [screenToFlowPosition]);

  const updateObserverDraw = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drawStartRef.current;
    const host = canvasRef.current?.getBoundingClientRect();
    if (!start || !host) return;
    setDrawPreview({
      left: Math.min(start.clientX, event.clientX) - host.left,
      top: Math.min(start.clientY, event.clientY) - host.top,
      width: Math.abs(event.clientX - start.clientX),
      height: Math.abs(event.clientY - start.clientY),
    });
  }, []);

  const finishObserverDraw = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drawStartRef.current;
    drawStartRef.current = null;
    setDrawPreview(null);
    if (!start) return;
    const end = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const bounds = {
      x: Math.min(start.flowX, end.x),
      y: Math.min(start.flowY, end.y),
      width: Math.abs(end.x - start.flowX),
      height: Math.abs(end.y - start.flowY),
    };
    if (bounds.width < 120 || bounds.height < 100) return;
    const observer: ObserverRegion = {
      id: createId("observer"),
      name: "New observer",
      instructions: "Watch this group for stalled work, contradictions, and failed attempts.",
      bounds,
      coveredNodeIds: coveredNodes(workflow.nodes, bounds),
      conditions: ["failed attempt", "stalled work"],
      extraRetries: 1,
      modelUpgradeTo: "Sol",
      escalationBehavior: "ask-user",
      status: "idle",
    };
    emit({ ...workflow, observers: [...workflow.observers, observer] });
    onSelectionChange({ type: "observer", id: observer.id });
    setMobileInspectorOpen(true);
    setObserverDrawMode(false);
  }, [emit, onSelectionChange, screenToFlowPosition, workflow]);

  const cancelObserverDraw = useCallback(() => {
    drawStartRef.current = null;
    setDrawPreview(null);
  }, []);

  const activeSelection = selection ?? { type: "workflow" as const, id: workflow.id };

  return (
    <section className={`loop-workspace-canvas${mobileInspectorOpen ? " is-inspector-open" : ""}${className ? ` ${className}` : ""}`}>
      <div className="loop-canvas-stage" ref={canvasRef} onDoubleClick={handleRootDoubleClick}>
        <ReactFlow<LoopFlowNode, LoopFlowEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStop={handleNodeDragStop}
          onNodeClick={(_event, node) => {
            const parsed = parseFlowId(node.id);
            if (parsed) { onSelectionChange({ type: parsed.kind, id: parsed.id }); setMobileInspectorOpen(true); }
          }}
          onEdgeClick={(_event, edge) => {
            const parsed = parseFlowId(edge.id);
            if (parsed?.kind === "edge") { onSelectionChange({ type: "edge", id: parsed.id }); setMobileInspectorOpen(true); }
          }}
          onPaneClick={() => { onSelectionChange({ type: "workflow", id: workflow.id }); setMobileInspectorOpen(false); }}
          onMoveEnd={(_event, viewport) => {
            const previous = workflow.viewport;
            if (Math.abs(previous.x - viewport.x) < 0.5 && Math.abs(previous.y - viewport.y) < 0.5 && Math.abs(previous.zoom - viewport.zoom) < 0.001) return;
            emit({ ...workflow, viewport });
          }}
          defaultViewport={workflow.viewport}
          minZoom={0.35}
          maxZoom={1.8}
          connectionMode={ConnectionMode.Loose}
          connectionRadius={32}
          panOnDrag={[1, 2]}
          panOnScroll
          zoomOnScroll={false}
          zoomOnPinch
          zoomOnDoubleClick={false}
          selectionOnDrag={false}
          nodesDraggable={!observerDrawMode}
          nodesConnectable={!observerDrawMode}
          elementsSelectable={!observerDrawMode}
          deleteKeyCode={null}
          elevateNodesOnSelect={false}
          proOptions={{ hideAttribution: true }}
          fitViewOptions={{ padding: 0.18, minZoom: 0.45, maxZoom: 1 }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--border)" />
        </ReactFlow>

        {observerDrawMode ? (
          <div
            className="loop-observer-draw-surface"
            aria-label="Draw an Observer region"
            onPointerDown={beginObserverDraw}
            onPointerMove={updateObserverDraw}
            onPointerUp={finishObserverDraw}
            onPointerCancel={cancelObserverDraw}
          >
            {drawPreview ? <span className="loop-observer-draw-preview" style={drawPreview} /> : null}
          </div>
        ) : null}

        <div className="loop-canvas-toolbar" role="toolbar" aria-label="Canvas controls">
          <button type="button" onClick={() => addAgent(screenToFlowPosition({
            x: (canvasRef.current?.getBoundingClientRect().left ?? 0) + (canvasRef.current?.clientWidth ?? 600) / 2,
            y: (canvasRef.current?.getBoundingClientRect().top ?? 0) + (canvasRef.current?.clientHeight ?? 400) / 2,
          }))} title="Add agent">
            <Bot size={15} aria-hidden="true" /><span>Add agent</span>
          </button>
          <button
            type="button"
            onClick={() => {
              const supervisor = workflow.observers[0];
              if (supervisor) { onSelectionChange({ type: "observer", id: supervisor.id }); setMobileInspectorOpen(true); }
            }}
            title="Open loop supervisor"
          >
            <Eye size={15} aria-hidden="true" /><span>Supervisor</span>
          </button>
          <button type="button" aria-expanded={connectOpen} onClick={() => setConnectOpen((open) => !open)} title="Connect agents">
            <Link2 size={15} aria-hidden="true" /><span>Connect</span>
          </button>
          <button type="button" onClick={() => { onSelectionChange({ type: "workflow", id: workflow.id }); setMobileInspectorOpen(true); }} title="Workflow settings">
            <Settings2 size={15} aria-hidden="true" /><span>Settings</span>
          </button>
          <span className="loop-toolbar-divider" />
          <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => void zoomOut({ duration: 140 })}><Minus size={15} /></button>
          <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => void zoomIn({ duration: 140 })}><Plus size={15} /></button>
          <button type="button" aria-label="Fit workflow" title="Fit workflow" onClick={() => void fitView({ padding: 0.18, duration: 180 })}><Maximize2 size={14} /></button>
        </div>

        {connectOpen ? (
          <form className="loop-connect-popover" onSubmit={(event) => { event.preventDefault(); connectNodes(connectSource, connectTarget); }}>
            <strong>Connect agents</strong>
            <label>Source<select aria-label="Connection source" value={connectSource} onChange={(event) => setConnectSource(event.target.value)}>{workflow.nodes.map((node) => <option value={node.id} key={node.id}>{node.name}</option>)}</select></label>
            <label>Target<select aria-label="Connection target" value={connectTarget} onChange={(event) => setConnectTarget(event.target.value)}>{workflow.nodes.map((node) => <option value={node.id} key={node.id}>{node.name}</option>)}</select></label>
            <button type="submit" disabled={!connectSource || !connectTarget || connectSource === connectTarget || workflow.edges.some((edge) => edge.source === connectSource && edge.target === connectTarget)}>Create edge</button>
          </form>
        ) : null}

        {workflow.nodes.length === 0 ? (
          <div className="loop-canvas-empty" aria-hidden="true">
            <Plus size={16} />
            <span>Double-click to add an Agent</span>
          </div>
        ) : null}
      </div>
      <SelectionInspector
        workflow={workflow}
        selection={activeSelection}
        onWorkflowChange={emit}
        onSelectionChange={onSelectionChange}
      />
      <button className="loop-mobile-inspector-close" type="button" aria-label="Close inspector" onClick={() => setMobileInspectorOpen(false)}><X size={15} /></button>
    </section>
  );
}

export function LoopWorkspaceCanvas(props: LoopWorkspaceCanvasProps) {
  return (
    <ReactFlowProvider>
      <LoopWorkspaceCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
