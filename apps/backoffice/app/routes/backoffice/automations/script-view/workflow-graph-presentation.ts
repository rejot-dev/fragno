import type {
  TerminalNode,
  WorkflowChildNode,
  WorkflowVisualizationSnapshot,
} from "@fragno-dev/workflow-visualizer-tokens";

import type { WorkflowGraphDetailMode } from "./script-view-mode";

interface WorkflowGraphPresentation {
  childrenByParent: Map<string, WorkflowChildNode[]>;
}

interface WorkflowTerminalDetails {
  label?: string;
  value?: string;
}

export function workflowTerminalDetails(
  terminal: TerminalNode,
  detailMode: WorkflowGraphDetailMode,
): WorkflowTerminalDetails {
  const label = !isDefaultTerminalLabel(terminal) ? terminal.label : undefined;
  if (detailMode !== "verbose") {
    return terminal.terminalType !== "final-return" && label ? { label } : {};
  }

  return {
    ...(label ? { label } : {}),
    ...(terminal.value.kind === "expression" ? { value: terminal.value.expression } : {}),
  };
}

function isDefaultTerminalLabel(terminal: TerminalNode): boolean {
  return (
    terminal.label === "return" || terminal.label === "early return" || terminal.label === "error"
  );
}

export function countRenderedWorkflowSteps(
  parentId: string,
  childrenByParent: Map<string, WorkflowChildNode[]>,
): number {
  return (childrenByParent.get(parentId) ?? []).reduce(
    (stepCount, child) =>
      stepCount +
      (child.kind === "step" ? 1 : 0) +
      countRenderedWorkflowSteps(child.id, childrenByParent),
    0,
  );
}

/** Preserve source control flow while indexing graph children by their parent node. */
export function createWorkflowGraphPresentation(
  visualization: WorkflowVisualizationSnapshot,
): WorkflowGraphPresentation {
  const childrenByParent = new Map<string, WorkflowChildNode[]>();

  for (const node of visualization.graph.nodes) {
    if (node.kind === "workflow") {
      continue;
    }
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }

  for (const [parentId, children] of childrenByParent) {
    childrenByParent.set(
      parentId,
      [...children]
        .sort((left, right) => left.order - right.order)
        .map((node, order) => ({ ...node, order }) as WorkflowChildNode),
    );
  }

  return { childrenByParent };
}
