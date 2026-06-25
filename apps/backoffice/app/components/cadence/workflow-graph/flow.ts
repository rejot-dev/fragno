/*
 * Turns a (focused) pipeline graph into React Flow nodes/edges, using React
 * Flow sub-flows: each workflow becomes a parent container node and its steps
 * become child nodes (`parentId` + `extent: "parent"`) that render *inside* it.
 * The trigger side (events → routers) sits in horizontal rows *above* the
 * container and connects down into it. See
 * https://reactflow.dev/examples/layout/sub-flow.
 *
 * Pure (no React) so it can be unit-tested.
 */

import type { GraphEdge, GraphNode, WorkflowGraph } from "@fragno-dev/workflow-visualizer";

import type { Edge, Node } from "@xyflow/react";

import { EDGE_STYLE } from "./node-meta";

/** Live run state for a node, injected after layout (see PipelineGraph). */
export type NodeRunState = {
  status: string;
  attempts: number;
  error?: string;
  emissionCount: number;
};
export type FlowNodeData = { node: GraphNode; run?: NodeRunState };
export type PipelineFlowNode = Node<FlowNodeData>;

export const PIPELINE_NODE_TYPE = "pipelineNode";
export const WORKFLOW_GROUP_TYPE = "workflowGroup";
export const LOOP_GROUP_TYPE = "loopGroup";

/** A node that can nest inside a container (a step or a loop block). */
type ContainerChild = Extract<GraphNode, { kind: "step" | "loop" }>;

// Geometry. Children stack vertically inside their container (top = input, bottom
// = output); loops are themselves containers, so they nest. Trigger rows sit above
// the workflow (events on top, routers below), flowing down into it.
const NODE_W = 248;
const STEP_GAP = 16;
const HEADER_H = 52;
const LOOP_HEADER_H = 40; // a loop's own header band (icon + header text)
const PAD = 16;
const GROUP_X = 0;
const BAND_GAP = 64;
// Horizontal spacing between sibling triggers in a row, and the vertical gap
// between the event row, the router row, and the workflow container below.
const TRIGGER_COL = NODE_W + 48;
const BAND_V_GAP = 132;

// Per-step height estimate, so the container is tall enough to show each step's
// text (label up to two lines, an optional detail line, and one row per branch
// condition). Slightly generous so nodes never overlap.
const STEP_BASE_H = 60; // icon + kind eyebrow + up-to-two-line label + padding
const STEP_DETAIL_H = 18; // sleep/wait detail line
const STEP_BRANCH_ROW_H = 22; // one row per enclosing condition
const STEP_EMPTY_INNER_H = 36;

function estimateStepHeight(step: Extract<GraphNode, { kind: "step" }>): number {
  let height = STEP_BASE_H;
  if (step.meta.duration || step.meta.until || step.meta.eventType || step.meta.condition) {
    height += STEP_DETAIL_H;
  }
  if (step.meta.returns) {
    height += STEP_BRANCH_ROW_H;
  }
  if (step.branch.length > 0) {
    height += 6 + step.branch.length * STEP_BRANCH_ROW_H;
  }
  return height;
}

/** A loop's header band grows by a row per condition gating the loop. */
function loopHeaderHeight(loop: Extract<GraphNode, { kind: "loop" }>): number {
  let height = LOOP_HEADER_H;
  if (loop.branch.length > 0) {
    height += 6 + loop.branch.length * STEP_BRANCH_ROW_H;
  }
  return height;
}

/**
 * Lay out the direct children of a container, recursing into loop blocks. Returns
 * the produced flow nodes (the container's own subtree) plus the content extent the
 * container must size itself to. Child positions are relative to their immediate
 * parent — React Flow composes the nesting — so a loop sizes to its body and the
 * workflow sizes to fit its loops. Loops grow outward by `PAD` per level while
 * steps keep a constant width, so the body stays readable at any depth.
 */
function layoutContainer(
  childrenByParent: Map<string, ContainerChild[]>,
  parentId: string,
  originX: number,
  originY: number,
): { nodes: PipelineFlowNode[]; contentWidth: number; contentHeight: number } {
  const children = (childrenByParent.get(parentId) ?? []).slice().sort((a, b) => a.order - b.order);
  const nodes: PipelineFlowNode[] = [];
  let y = originY;
  let contentWidth = NODE_W;

  for (const child of children) {
    if (child.kind === "step") {
      const height = estimateStepHeight(child);
      nodes.push({
        id: child.id,
        type: PIPELINE_NODE_TYPE,
        parentId,
        extent: "parent",
        position: { x: originX, y },
        data: { node: child },
        style: { width: NODE_W, height },
      });
      y += height + STEP_GAP;
    } else {
      const headerH = loopHeaderHeight(child);
      const sub = layoutContainer(childrenByParent, child.id, PAD, headerH);
      const loopW = sub.contentWidth + PAD * 2;
      const loopH = headerH + sub.contentHeight + PAD;
      // Loop container — must precede its children in the array.
      nodes.push({
        id: child.id,
        type: LOOP_GROUP_TYPE,
        parentId,
        extent: "parent",
        position: { x: originX, y },
        data: { node: child },
        style: { width: loopW, height: loopH },
      });
      nodes.push(...sub.nodes);
      contentWidth = Math.max(contentWidth, loopW);
      y += loopH + STEP_GAP;
    }
  }

  const contentHeight = children.length > 0 ? y - originY - STEP_GAP : STEP_EMPTY_INNER_H;
  return { nodes, contentWidth, contentHeight };
}

export function buildFlowElements(graph: WorkflowGraph): {
  nodes: PipelineFlowNode[];
  edges: Edge[];
} {
  const groupNodes: PipelineFlowNode[] = [];
  const triggerNodes = new Map<string, PipelineFlowNode>();

  const childrenByParent = groupByParent(graph);
  const routersForWorkflow = mergeIncoming(graph.edges, ["spawns", "sends"]);
  const eventsForRouter = mergeIncoming(graph.edges, ["matches"]);
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  let cursorY = 0;
  for (const workflow of graph.nodes) {
    if (workflow.kind !== "workflow") {
      continue;
    }

    // Recursively lay out the workflow's body (steps and nested loop blocks).
    const inner = layoutContainer(childrenByParent, workflow.id, PAD, HEADER_H + PAD);
    const groupW = inner.contentWidth + PAD * 2;
    const groupH = HEADER_H + PAD + inner.contentHeight + PAD;

    // Two trigger rows sit above the container: events on top, routers below.
    const eventY = cursorY;
    const routerY = cursorY + BAND_V_GAP;
    const groupY = cursorY + BAND_V_GAP * 2;
    const groupCenterX = GROUP_X + groupW / 2;

    // Parent container — must precede its children in the array.
    groupNodes.push({
      id: workflow.id,
      type: WORKFLOW_GROUP_TYPE,
      position: { x: GROUP_X, y: groupY },
      data: { node: workflow },
      style: { width: groupW, height: groupH },
    });
    groupNodes.push(...inner.nodes);

    // Trigger rows above the container: routers centered over the container,
    // and each router's events centered over that router.
    const routerIds = routersForWorkflow.get(workflow.id) ?? [];
    routerIds.forEach((routerId, i) => {
      const routerX = stackX(groupCenterX, routerIds.length, i);
      placeTrigger(triggerNodes, nodeById, routerId, { x: routerX, y: routerY });

      const eventIds = eventsForRouter.get(routerId) ?? [];
      const routerCenterX = routerX + NODE_W / 2;
      eventIds.forEach((eventId, j) => {
        placeTrigger(triggerNodes, nodeById, eventId, {
          x: stackX(routerCenterX, eventIds.length, j),
          y: eventY,
        });
      });
    });

    cursorY = groupY + groupH + BAND_GAP;
  }

  // Any node not yet placed (orphan events / scripts) — a trailing row.
  // Workflows, loops, and steps are laid out inside their containers above.
  let trailingX = GROUP_X;
  for (const node of graph.nodes) {
    if (node.kind === "workflow" || node.kind === "loop" || node.kind === "step") {
      continue;
    }
    if (triggerNodes.has(node.id)) {
      continue;
    }
    triggerNodes.set(node.id, {
      id: node.id,
      type: PIPELINE_NODE_TYPE,
      position: { x: trailingX, y: cursorY },
      data: { node },
      style: { width: NODE_W },
    });
    trailingX += TRIGGER_COL;
  }

  const nodes = [...groupNodes, ...triggerNodes.values()];
  const edges = toEdges(graph.edges);
  return { nodes, edges };
}

// Spread `count` siblings horizontally, centered on `centerX`, returning the
// left edge (x) for the node at `index`.
function stackX(centerX: number, count: number, index: number): number {
  return centerX - NODE_W / 2 + (index - (count - 1) / 2) * TRIGGER_COL;
}

function placeTrigger(
  out: Map<string, PipelineFlowNode>,
  nodeById: Map<string, GraphNode>,
  id: string,
  position: { x: number; y: number },
): void {
  if (out.has(id)) {
    return;
  }
  const node = nodeById.get(id);
  if (!node) {
    return;
  }
  out.set(id, {
    id,
    type: PIPELINE_NODE_TYPE,
    position,
    data: { node },
    style: { width: NODE_W },
  });
}

/** Group every step and loop block by the id of its container (workflow or loop). */
function groupByParent(graph: WorkflowGraph): Map<string, ContainerChild[]> {
  const map = new Map<string, ContainerChild[]>();
  for (const node of graph.nodes) {
    if (node.kind !== "step" && node.kind !== "loop") {
      continue;
    }
    const list = map.get(node.parentId) ?? [];
    list.push(node);
    map.set(node.parentId, list);
  }
  return map;
}

/** target node id -> source node ids, for the given edge types. */
function mergeIncoming(edges: GraphEdge[], types: GraphEdge["type"][]): Map<string, string[]> {
  const set = new Set(types);
  const map = new Map<string, string[]>();
  for (const edge of edges) {
    if (!set.has(edge.type)) {
      continue;
    }
    const list = map.get(edge.to) ?? [];
    if (!list.includes(edge.from)) {
      list.push(edge.from);
    }
    map.set(edge.to, list);
  }
  return map;
}

function toEdges(graphEdges: GraphEdge[]): Edge[] {
  const edges: Edge[] = [];
  for (const edge of graphEdges) {
    // `contains` is represented by visual nesting in the sub-flow, not a line.
    if (edge.type === "contains") {
      continue;
    }
    const style = EDGE_STYLE[edge.type];
    // Step sequence is wired bottom → top inside the sub-flow: each step's
    // bottom handle connects to the next step's top handle.
    const sequence = edge.type === "sequence";
    edges.push({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      // Steps share the same column, so a straight vertical reads as a clean
      // spine; trigger edges drop between rows, so they get rounded orthogonal
      // routing.
      ...(sequence
        ? { sourceHandle: "step-out", targetHandle: "step-in", type: "straight" }
        : { type: "smoothstep" }),
      animated: style.animated,
      style: {
        stroke: style.stroke,
        strokeWidth: 1.5,
        ...(style.dashed ? { strokeDasharray: "4 4" } : {}),
      },
      ...(edge.label ? { label: edge.label } : {}),
    });
  }
  return edges;
}
