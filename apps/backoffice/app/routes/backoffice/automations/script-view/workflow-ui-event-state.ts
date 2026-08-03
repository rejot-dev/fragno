import { setByPath } from "@json-render/core";

import type { BackofficeUiResultV1 } from "@/backoffice-ui/result";

import type { WorkflowRunEvent } from "./workflow-run-presentation";

type WorkflowUiEventBinding = {
  eventType: string;
  payloadExpression: unknown;
};

export type SubmittedWorkflowUiEvent = {
  event: WorkflowRunEvent;
  state: Record<string, unknown>;
};

export function workflowUiEventBindings(
  ui: BackofficeUiResultV1["$ui"],
): readonly WorkflowUiEventBinding[] {
  return Object.values(ui.spec.elements).flatMap((element) =>
    element.type === "WorkflowEventButton" && typeof element.props.eventType === "string"
      ? [{ eventType: element.props.eventType, payloadExpression: element.props.payload }]
      : [],
  );
}

export function activeWorkflowUiEventTypes(
  ui: BackofficeUiResultV1["$ui"],
  waitingEventTypes: readonly string[],
): ReadonlySet<string> {
  const waitingEventTypeSet = new Set(waitingEventTypes);
  const activeEventTypes = new Set<string>();
  for (const binding of workflowUiEventBindings(ui)) {
    if (waitingEventTypeSet.has(binding.eventType)) {
      activeEventTypes.add(binding.eventType);
    }
  }
  return activeEventTypes;
}

export function submittedWorkflowUiEvent({
  ui,
  events,
  completedAt,
}: {
  ui: BackofficeUiResultV1["$ui"];
  events: readonly WorkflowRunEvent[];
  completedAt?: Date | string;
}): SubmittedWorkflowUiEvent | null {
  const bindings = workflowUiEventBindings(ui);
  const completedAtTimestamp = completedAt ? timestamp(completedAt) : Number.NEGATIVE_INFINITY;
  const candidates = events
    .flatMap((event) => {
      const binding = bindings.find((candidate) => candidate.eventType === event.type);
      return binding && timestamp(event.createdAt) >= completedAtTimestamp
        ? [{ event, binding }]
        : [];
    })
    .sort(
      (left, right) =>
        timestamp(right.event.createdAt) - timestamp(left.event.createdAt) ||
        right.event.id.localeCompare(left.event.id),
    );
  const submitted = candidates[0];
  if (!submitted) {
    return null;
  }

  const state = structuredClone(ui.state);
  restoreWorkflowUiStateFromSubmittedPayload(
    state,
    submitted.binding.payloadExpression,
    submitted.event.payload,
  );
  return { event: submitted.event, state };
}

function restoreWorkflowUiStateFromSubmittedPayload(
  state: Record<string, unknown>,
  payloadExpression: unknown,
  submittedPayload: unknown,
) {
  if (!payloadExpression || typeof payloadExpression !== "object") {
    return;
  }

  if (Array.isArray(payloadExpression)) {
    if (!Array.isArray(submittedPayload)) {
      return;
    }
    for (const [index, itemExpression] of payloadExpression.entries()) {
      if (index < submittedPayload.length) {
        restoreWorkflowUiStateFromSubmittedPayload(state, itemExpression, submittedPayload[index]);
      }
    }
    return;
  }

  const expression = payloadExpression as Record<string, unknown>;
  if (Object.keys(expression).length === 1 && typeof expression.$state === "string") {
    setByPath(state, expression.$state, submittedPayload);
    return;
  }

  if (
    Object.keys(expression).some((key) => key.startsWith("$")) ||
    !submittedPayload ||
    typeof submittedPayload !== "object" ||
    Array.isArray(submittedPayload)
  ) {
    return;
  }

  const payload = submittedPayload as Record<string, unknown>;
  for (const [propertyName, propertyExpression] of Object.entries(expression)) {
    if (Object.hasOwn(payload, propertyName)) {
      restoreWorkflowUiStateFromSubmittedPayload(state, propertyExpression, payload[propertyName]);
    }
  }
}

function timestamp(value: Date | string) {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}
