import type {
  BranchNode,
  ConditionNode,
  SemanticReference,
  SourceRange,
  SpecificEventGuardAnnotation,
  TerminalNode,
  WorkflowChildNode,
  WorkflowVisualizationSnapshot,
} from "@fragno-dev/workflow-visualizer-tokens";

import type { WorkflowGraphDetailMode } from "./script-view-mode";

export interface WorkflowEventGuardPresentation {
  workflowId: string;
  conditionId: string;
  eventSource: string;
  eventType: string;
  subject: SemanticReference;
  source: SourceRange;
}

export interface WorkflowGraphPresentation {
  childrenByParent: Map<string, WorkflowChildNode[]>;
  eventGuardByWorkflowId: Map<string, WorkflowEventGuardPresentation>;
}

export interface WorkflowTerminalDetails {
  label?: string;
  value?: string;
}

export function workflowTerminalDetails(
  terminal: TerminalNode,
  detailMode: WorkflowGraphDetailMode,
): WorkflowTerminalDetails {
  const label = !isDefaultTerminalLabel(terminal) ? terminal.label : undefined;
  if (detailMode === "simple") {
    return terminal.terminalType !== "final-return" && label ? { label } : {};
  }

  return {
    ...(label ? { label } : {}),
    ...(terminal.value ? { value: terminal.value } : {}),
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

/** Remove routing-only guard branches while preserving the accepted workflow path. */
export function createWorkflowGraphPresentation(
  visualization: WorkflowVisualizationSnapshot,
): WorkflowGraphPresentation {
  const childNodes = visualization.graph.nodes.filter(
    (node): node is WorkflowChildNode => node.kind !== "workflow",
  );
  const originalChildrenByParent = indexOriginalChildren(childNodes);
  const hiddenNodeIds = new Set<string>();
  const parentOverrides = new Map<string, string>();
  const sortOrderOverrides = new Map<string, number>();
  const eventGuardByWorkflowId = new Map<string, WorkflowEventGuardPresentation>();

  for (const workflow of visualization.graph.nodes) {
    if (workflow.kind !== "workflow") {
      continue;
    }
    const guard = leadingWorkflowEventGuard(workflow.id, originalChildrenByParent);
    if (!guard) {
      continue;
    }

    eventGuardByWorkflowId.set(workflow.id, {
      workflowId: workflow.id,
      conditionId: guard.condition.id,
      eventSource: guard.annotation.eventSource,
      eventType: guard.annotation.eventType,
      subject: guard.annotation.subject,
      source: guard.condition.source,
    });
    hiddenNodeIds.add(guard.condition.id);

    const guardDescendantIds = descendantIds(guard.condition.id, originalChildrenByParent);
    const acceptedBranch = acceptedBranchForGuard(guard.condition, guard.annotation, childNodes);
    if (!acceptedBranch) {
      for (const descendantId of guardDescendantIds) {
        hiddenNodeIds.add(descendantId);
      }
      continue;
    }

    const acceptedDescendantIds = descendantIds(acceptedBranch.id, originalChildrenByParent);
    for (const descendantId of guardDescendantIds) {
      if (!acceptedDescendantIds.has(descendantId)) {
        hiddenNodeIds.add(descendantId);
      }
    }
    hiddenNodeIds.add(acceptedBranch.id);

    const acceptedChildren = originalChildrenByParent.get(acceptedBranch.id) ?? [];
    for (const [index, acceptedChild] of acceptedChildren.entries()) {
      parentOverrides.set(acceptedChild.id, workflow.id);
      sortOrderOverrides.set(
        acceptedChild.id,
        guard.condition.order + (index + 1) / (acceptedChildren.length + 1),
      );
    }
  }

  const entriesByParent = new Map<string, Array<{ node: WorkflowChildNode; sortOrder: number }>>();
  for (const node of childNodes) {
    if (hiddenNodeIds.has(node.id)) {
      continue;
    }
    const parentId = parentOverrides.get(node.id) ?? node.parentId;
    const siblings = entriesByParent.get(parentId) ?? [];
    siblings.push({
      node,
      sortOrder: sortOrderOverrides.get(node.id) ?? node.order,
    });
    entriesByParent.set(parentId, siblings);
  }

  const childrenByParent = new Map<string, WorkflowChildNode[]>();
  for (const [parentId, entries] of entriesByParent) {
    const children = [...entries]
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map(({ node }, order) => ({ ...node, parentId, order }) as WorkflowChildNode);
    childrenByParent.set(parentId, children);
  }

  return { childrenByParent, eventGuardByWorkflowId };
}

function leadingWorkflowEventGuard(
  workflowId: string,
  childrenByParent: Map<string, WorkflowChildNode[]>,
): { condition: ConditionNode; annotation: SpecificEventGuardAnnotation } | null {
  const firstChild = [...(childrenByParent.get(workflowId) ?? [])]
    .sort((left, right) => left.order - right.order)
    .at(0);
  if (firstChild?.kind !== "condition" || firstChild.analysis.status !== "complete") {
    return null;
  }
  const annotation = firstChild.analysis.annotations.find(
    (candidate): candidate is SpecificEventGuardAnnotation =>
      candidate.kind === "specific-event-guard",
  );
  return annotation ? { condition: firstChild, annotation } : null;
}

function acceptedBranchForGuard(
  condition: ConditionNode,
  annotation: SpecificEventGuardAnnotation,
  children: WorkflowChildNode[],
): BranchNode | null {
  if (annotation.acceptedPath === "fallthrough") {
    return null;
  }
  return (
    children.find(
      (node): node is BranchNode =>
        node.kind === "branch" &&
        node.parentId === condition.id &&
        node.branchType === annotation.acceptedPath,
    ) ?? null
  );
}

function indexOriginalChildren(nodes: WorkflowChildNode[]): Map<string, WorkflowChildNode[]> {
  const childrenByParent = new Map<string, WorkflowChildNode[]>();
  for (const node of nodes) {
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }
  return childrenByParent;
}

function descendantIds(
  parentId: string,
  childrenByParent: Map<string, WorkflowChildNode[]>,
): Set<string> {
  const descendants = new Set<string>();
  const pending = [...(childrenByParent.get(parentId) ?? [])];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node || descendants.has(node.id)) {
      continue;
    }
    descendants.add(node.id);
    pending.push(...(childrenByParent.get(node.id) ?? []));
  }
  return descendants;
}
