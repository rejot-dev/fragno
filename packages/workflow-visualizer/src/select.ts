import { type Diagnostic, type GraphNode, type WorkflowGraph, workflowNodeId } from "./model.ts";

const STRUCTURAL_DIAGNOSTIC_CODES = new Set(["duplicate-workflow"]);

/**
 * A diagnostic survives focusing when it is (a) path-less, (b) attached to a
 * file backing one of the kept nodes, (c) any `error` (a parse error in the
 * file you just edited must never be swallowed into a blank canvas), or (d) a
 * structural workspace diagnostic.
 */
function keepDiagnostic(diagnostic: Diagnostic, keptPaths: Set<string>): boolean {
  if (!diagnostic.ref?.path || keptPaths.has(diagnostic.ref.path)) {
    return true;
  }
  if (diagnostic.severity === "error") {
    return true;
  }
  return diagnostic.code !== undefined && STRUCTURAL_DIAGNOSTIC_CODES.has(diagnostic.code);
}

/**
 * Focus a graph on a single workflow: keep that workflow and its steps. Edges
 * are kept only when both endpoints survive.
 *
 * Workspace-level errors always survive — see {@link keepDiagnostic} — so a
 * syntax error shows in the visualizer rather than collapsing the view to a
 * blank, unexplained canvas.
 *
 * Returns a node/edge-empty graph (still carrying those diagnostics) when the
 * workflow is not found.
 */
export function selectWorkflow(graph: WorkflowGraph, workflowName: string): WorkflowGraph {
  const workflowId = workflowNodeId(workflowName);
  const workflow = graph.nodes.find((n) => n.id === workflowId && n.kind === "workflow");
  if (!workflow) {
    // The workflow itself parsed away (e.g. a syntax error broke its
    // `defineWorkflow`). Keep nothing to draw, but still report what's wrong.
    const diagnostics = graph.diagnostics.filter((d) => keepDiagnostic(d, new Set()));
    return { version: 1, nodes: [], edges: [], diagnostics };
  }

  const keep = new Set<string>([workflowId]);

  // Steps and loop blocks belonging to this workflow.
  for (const node of graph.nodes) {
    if ((node.kind === "step" || node.kind === "loop") && node.workflowName === workflowName) {
      keep.add(node.id);
    }
  }

  const nodes = graph.nodes.filter((n) => keep.has(n.id));
  const edges = graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to));

  // Keep diagnostics that point at a file backing one of the kept nodes, plus
  // the path-less, error, and structural ones (see {@link keepDiagnostic}).
  const keptPaths = new Set<string>();
  for (const node of nodes) {
    const path = nodePath(node);
    if (path) {
      keptPaths.add(path);
    }
  }
  const diagnostics = graph.diagnostics.filter((d) => keepDiagnostic(d, keptPaths));

  return { version: 1, nodes, edges, diagnostics };
}

function nodePath(node: GraphNode): string | undefined {
  switch (node.kind) {
    case "workflow":
    case "router":
    case "script":
      return node.path;
    case "step":
    case "loop":
      return node.ref?.path;
    case "event":
      return undefined;
  }

  return undefined;
}

/** A lightweight summary of each workflow, for building a selector. */
export interface WorkflowSummary {
  name: string;
  label: string;
  remote: boolean;
  stepCount: number;
}

export function listWorkflows(graph: WorkflowGraph): WorkflowSummary[] {
  const stepCounts = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.kind === "step") {
      stepCounts.set(node.workflowName, (stepCounts.get(node.workflowName) ?? 0) + 1);
    }
  }
  return graph.nodes
    .filter((n) => n.kind === "workflow")
    .map((n) => {
      const workflow = n as Extract<GraphNode, { kind: "workflow" }>;
      return {
        name: workflow.name,
        label: workflow.label,
        remote: workflow.remote,
        stepCount: stepCounts.get(workflow.name) ?? 0,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}
