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

type WorkflowRunStepSpan = Extract<WorkflowRunStep["timing"], { kind: "span" }>;

/** One run of a step inside a loop, named as it ran. */
export type WorkflowRunStepIteration = Pick<
  WorkflowRunStep,
  "id" | "label" | "status" | "attempts" | "detail"
> & { timing: WorkflowRunStepSpan };

/**
 * What only a run knows about a step; `detail` replaces the step's static detail when set. A step
 * inside a loop that has run is known by its iterations, oldest first.
 */
export type WorkflowRunStepRuntime =
  | ({ kind: "single" } & Pick<WorkflowRunStep, "status" | "attempts" | "timing" | "detail">)
  | {
      kind: "repeated";
      iterations: readonly [WorkflowRunStepIteration, ...WorkflowRunStepIteration[]];
    };

/**
 * Projects one workflow from a visualizer graph onto timeline nodes. Constructs without durable
 * steps or exits are dropped, since the timeline only shows what a run can record or end at.
 * `runtimeOf` learns whether the step is inside a loop, so a run can report its iterations.
 */
export function workflowRunNodesFromGraph(
  graph: WorkflowGraph,
  workflowId: string,
  runtimeOf: (step: StepNode, inLoop: boolean) => WorkflowRunStepRuntime,
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

  function sequenceOf(parentId: string, inLoop: boolean): WorkflowRunNode[] {
    return childrenOf(parentId).flatMap((child) => toNodes(child, inLoop));
  }

  function toStep(node: StepNode, inLoop: boolean): WorkflowRunStep {
    const runtime = runtimeOf(node, inLoop);
    const label = stepLabel(node);
    const activity = node.stepType === "do" ? "work" : "wait";
    const children = nestedSteps(node.id, inLoop);
    if (runtime.kind === "single") {
      return {
        id: node.id,
        label,
        detail: runtime.detail ?? staticStepDetail(node),
        status: runtime.status,
        activity,
        attempts: runtime.attempts,
        timing: runtime.timing,
        children,
        iterations: [],
      };
    }

    // The step reads as its newest iteration, over the time from its first to its newest.
    const [first] = runtime.iterations;
    const latest = runtime.iterations.at(-1) ?? first;
    return {
      id: node.id,
      label,
      detail: latest.detail ?? staticStepDetail(node),
      status: latest.status,
      activity,
      attempts: latest.attempts,
      timing: { kind: "span", startedAt: first.timing.startedAt, endedAt: latest.timing.endedAt },
      children,
      iterations: runtime.iterations.map((iteration) => ({
        ...iteration,
        detail: iteration.detail ?? staticStepDetail(node),
        activity,
        children: [],
        iterations: [],
      })),
    };
  }

  // Control flow inside a step callback is flattened: the timeline nests steps, not their logic.
  function nestedSteps(parentId: string, inLoop: boolean): WorkflowRunStep[] {
    return childrenOf(parentId).flatMap((child) =>
      child.kind === "step"
        ? [toStep(child, inLoop)]
        : nestedSteps(child.id, inLoop || child.kind === "loop"),
    );
  }

  function conditionNodes(node: ConditionNode, inLoop: boolean): WorkflowRunNode[] {
    const children = childrenOf(node.id);
    const thenBranch = children.find(
      (child) => child.kind === "branch" && child.branchType === "then",
    );
    const elseBranch = children.find(
      (child) => child.kind === "branch" && child.branchType === "else",
    );
    // An `if` without an `else` owns its children directly; not taking it falls through.
    const taken = thenBranch
      ? sequenceOf(thenBranch.id, inLoop)
      : elseBranch
        ? []
        : sequenceOf(node.id, inLoop);
    const notTaken = elseBranch ? sequenceOf(elseBranch.id, inLoop) : [];
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

  function toNodes(node: WorkflowChildNode, inLoop: boolean): WorkflowRunNode[] {
    switch (node.kind) {
      case "step":
        return [{ kind: "step", step: toStep(node, inLoop) }];
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
        return conditionNodes(node, inLoop);
      case "parallel": {
        const branches: WorkflowRunBranch[] = childrenOf(node.id).flatMap((branch, index) => {
          const nodes = sequenceOf(branch.id, inLoop);
          return nodes.length === 0
            ? []
            : [{ id: branch.id, label: index === 0 ? node.label : null, nodes }];
        });
        const only = branches.length === 1 ? branches[0] : undefined;
        if (only) {
          return [{ kind: "section", id: node.id, label: node.label, nodes: only.nodes }];
        }
        return branches.length === 0 ? [] : [{ kind: "fork", id: node.id, runs: "all", branches }];
      }
      case "loop": {
        const nodes = sequenceOf(node.id, true);
        const label = node.expression ? `${node.loopType} (${node.expression})` : node.loopType;
        return nodes.length === 0 ? [] : [{ kind: "loop", id: node.id, label, nodes }];
      }
      case "try": {
        const part = (branchType: "try" | "catch" | "finally") =>
          childrenOf(node.id).flatMap((branch) =>
            branch.kind === "branch" && branch.branchType === branchType
              ? sequenceOf(branch.id, inLoop)
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
        return sequenceOf(node.id, inLoop);
    }
    throw new Error("Unsupported workflow graph node.");
  }

  return sequenceOf(workflowId, false);
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
