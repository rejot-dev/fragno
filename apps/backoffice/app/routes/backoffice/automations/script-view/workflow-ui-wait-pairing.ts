import type { StepNode, WorkflowChildNode } from "@fragno-dev/workflow-visualizer-tokens";

import { parseBackofficeUiResult } from "@/backoffice-ui/result";

import type { WorkflowStepRunState } from "./workflow-run-presentation";
import { workflowUiEventBindings } from "./workflow-ui-event-state";

export type WorkflowUiWaitPair = {
  uiStep: StepNode;
  waitStep: StepNode;
  uiState: WorkflowStepRunState;
  waitState?: WorkflowStepRunState;
};

export type WorkflowUiWaitPairings = {
  byUiStepId: ReadonlyMap<string, WorkflowUiWaitPair>;
  uiStepIdByWaitStepId: ReadonlyMap<string, string>;
};

export function createWorkflowUiWaitPairings({
  childrenByParent,
  stepStatesByNodeId,
}: {
  childrenByParent: ReadonlyMap<string, readonly WorkflowChildNode[]>;
  stepStatesByNodeId?: ReadonlyMap<string, WorkflowStepRunState>;
}): WorkflowUiWaitPairings {
  const byUiStepId = new Map<string, WorkflowUiWaitPair>();
  const uiStepIdByWaitStepId = new Map<string, string>();

  for (const siblings of childrenByParent.values()) {
    for (const [index, candidate] of siblings.entries()) {
      const waitStep = siblings[index + 1];
      if (
        candidate.kind !== "step" ||
        candidate.stepType !== "do" ||
        waitStep?.kind !== "step" ||
        waitStep.stepType !== "waitForEvent"
      ) {
        continue;
      }
      const uiState = stepStatesByNodeId?.get(candidate.id);
      if (uiState?.status !== "completed") {
        continue;
      }
      const parsedResult = parseBackofficeUiResult(uiState.result);
      if (parsedResult.kind !== "valid") {
        continue;
      }
      const waitState = stepStatesByNodeId?.get(waitStep.id);
      const eventType = waitStep.meta.eventType ?? waitState?.waitEventType;
      if (
        !eventType ||
        !workflowUiEventBindings(parsedResult.value.$ui).some(
          (binding) => binding.eventType === eventType,
        )
      ) {
        continue;
      }

      byUiStepId.set(candidate.id, { uiStep: candidate, waitStep, uiState, waitState });
      uiStepIdByWaitStepId.set(waitStep.id, candidate.id);
    }
  }

  return { byUiStepId, uiStepIdByWaitStepId };
}

export function workflowUiWaitRunState(
  pair: WorkflowUiWaitPair | undefined,
): WorkflowStepRunState | undefined {
  if (!pair?.waitState) {
    return undefined;
  }

  return {
    ...pair.uiState,
    status: pair.waitState.status,
    attempts: pair.waitState.attempts,
    ...(pair.waitState.completedAt ? { completedAt: pair.waitState.completedAt } : {}),
    ...(pair.waitState.error ? { error: pair.waitState.error } : {}),
    ...(pair.waitState.waitEventType ? { waitEventType: pair.waitState.waitEventType } : {}),
    emissionCount: pair.waitState.emissionCount,
    current: pair.waitState.current,
  };
}
