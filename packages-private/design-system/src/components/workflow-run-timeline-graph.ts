import type {
  ConditionNode,
  StepNode,
  WorkflowChildNode,
  WorkflowGraph,
} from "@fragno-dev/workflow-visualizer-tokens";

import type {
  WorkflowRunBranch,
  WorkflowRunNode,
  WorkflowRunStep,
} from "./workflow-run-timeline-model";

/** What only a run knows about a step; `detail` replaces the step's static detail when set. */
export type WorkflowRunStepRuntime = Pick<
  WorkflowRunStep,
  "status" | "attempts" | "timing" | "detail"
>;

/**
 * Projects one workflow from a visualizer graph onto timeline nodes. Constructs without durable
 * steps or exits are dropped, since the timeline only shows what a run can record or end at.
 */
export function workflowRunNodesFromGraph(
  graph: WorkflowGraph,
  workflowId: string,
  runtimeOf: (step: StepNode) => WorkflowRunStepRuntime,
): WorkflowRunNode[] {
  const childrenByParent = new Map<string, WorkflowChildNode[]>();
  for (const node of graph.nodes) {
    if (node.kind !== "workflow") {
      childrenByParent.set(node.parentId, [...(childrenByParent.get(node.parentId) ?? []), node]);
    }
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) => left.order - right.order);
  }
  const childrenOf = (parentId: string) => childrenByParent.get(parentId) ?? [];

  function sequenceOf(parentId: string): WorkflowRunNode[] {
    return childrenOf(parentId).flatMap(toNodes);
  }

  function toStep(node: StepNode): WorkflowRunStep {
    const runtime = runtimeOf(node);
    return {
      id: node.id,
      label: stepLabel(node),
      detail: runtime.detail ?? staticStepDetail(node),
      status: runtime.status,
      activity: node.stepType === "do" ? "work" : "wait",
      attempts: runtime.attempts,
      timing: runtime.timing,
      children: nestedSteps(node.id),
    };
  }

  // Control flow inside a step callback is flattened: the timeline nests steps, not their logic.
  function nestedSteps(parentId: string): WorkflowRunStep[] {
    return childrenOf(parentId).flatMap((child) =>
      child.kind === "step" ? [toStep(child)] : nestedSteps(child.id),
    );
  }

  function conditionNodes(node: ConditionNode): WorkflowRunNode[] {
    const children = childrenOf(node.id);
    const thenBranch = children.find(
      (child) => child.kind === "branch" && child.branchType === "then",
    );
    const elseBranch = children.find(
      (child) => child.kind === "branch" && child.branchType === "else",
    );
    // An `if` without an `else` owns its children directly; not taking it falls through.
    const taken = thenBranch ? sequenceOf(thenBranch.id) : elseBranch ? [] : sequenceOf(node.id);
    const notTaken = elseBranch ? sequenceOf(elseBranch.id) : [];
    if (taken.length === 0 && notTaken.length === 0) {
      return [];
    }
    return [
      {
        kind: "fork",
        id: node.id,
        runs: "one",
        branches: [
          { id: thenBranch?.id ?? `${node.id}/then`, label: node.label, nodes: taken },
          {
            id: elseBranch?.id ?? `${node.id}/fallthrough`,
            label: elseBranch ? "else" : null,
            nodes: notTaken,
          },
        ],
      },
    ];
  }

  function toNodes(node: WorkflowChildNode): WorkflowRunNode[] {
    switch (node.kind) {
      case "step":
        return [{ kind: "step", step: toStep(node) }];
      case "terminal":
        return [
          {
            kind: "end",
            end: {
              id: node.id,
              label: node.label,
              reason: node.terminalType === "error" ? "error" : "return",
            },
          },
        ];
      // The path stops at the throw and continues in the catch handler of the enclosing try.
      case "caught-throw":
        return [
          {
            kind: "end",
            end: { id: node.id, label: node.value || node.label, reason: "caught" },
          },
        ];
      case "condition":
        return conditionNodes(node);
      case "parallel": {
        const branches: WorkflowRunBranch[] = childrenOf(node.id).flatMap((branch, index) => {
          const nodes = sequenceOf(branch.id);
          return nodes.length === 0
            ? []
            : [{ id: branch.id, label: index === 0 ? node.label : null, nodes }];
        });
        const only = branches.length === 1 ? branches[0] : undefined;
        if (only) {
          return [
            { kind: "section", id: node.id, label: node.label, repeats: false, nodes: only.nodes },
          ];
        }
        return branches.length === 0 ? [] : [{ kind: "fork", id: node.id, runs: "all", branches }];
      }
      case "loop": {
        const nodes = sequenceOf(node.id);
        const label = `${node.loopType} ${node.expression}`.trim();
        return nodes.length === 0
          ? []
          : [{ kind: "section", id: node.id, label, repeats: true, nodes }];
      }
      case "try": {
        const part = (branchType: "try" | "catch" | "finally") =>
          childrenOf(node.id).flatMap((branch) =>
            branch.kind === "branch" && branch.branchType === branchType
              ? sequenceOf(branch.id)
              : [],
          );
        const body = part("try");
        const handler = part("catch");
        const cleanup = part("finally");
        return body.length + handler.length + cleanup.length === 0
          ? []
          : [{ kind: "try", id: node.id, body, catch: handler, finally: cleanup }];
      }
      case "branch":
        return sequenceOf(node.id);
    }
    throw new Error("Unsupported workflow graph node.");
  }

  return sequenceOf(workflowId);
}

// Dynamic step names only have a placeholder label, so their static parts stand in for it.
function stepLabel(node: StepNode): string {
  return node.nameTemplate ? node.nameTemplate.staticParts.join("…").trim() : node.label;
}

function staticStepDetail(node: StepNode): string | null {
  switch (node.stepType) {
    case "do":
      return null;
    case "sleep":
      return node.meta.duration ?? null;
    case "sleepUntil":
      return node.meta.until ?? null;
    case "waitForEvent":
      return node.meta.eventType === node.label ? null : (node.meta.eventType ?? null);
  }
  throw new Error("Unsupported workflow step type.");
}
