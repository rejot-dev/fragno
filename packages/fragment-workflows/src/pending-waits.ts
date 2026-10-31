import { parseStepKey } from "./step-identity";
import { isSystemEventActor } from "./system-events";

/** The fields of a step record that decide whether it still waits for an event. */
export type WorkflowWaitStep = {
  stepKey: string;
  parentStepKey: string | null;
  type: string;
  status: string;
  waitEventType: string | null;
};

/** The fields of an event record that decide whether a wait will take it. */
export type WorkflowWaitEvent = {
  type: string;
  actor: string;
  consumedByStepKey: string | null;
};

const TERMINAL_STEP_STATUSES = new Set(["completed", "errored"]);

/**
 * The event types a run still needs sent, each once, from its steps and events in the order they
 * were created. A waiting step takes an event of its type already sent and not yet consumed, as
 * when parallel waits suspend the run before each consumes its event, so it needs nothing more.
 * An abandoned wait takes nothing.
 *
 * A wait's deadline is left out: once it passes, the run times out on its next wake whatever is
 * sent.
 */
export function pendingWaitEventTypes({
  steps,
  events,
}: {
  steps: readonly WorkflowWaitStep[];
  events: readonly WorkflowWaitEvent[];
}): string[] {
  const queued = new Map<string, number>();
  for (const event of events) {
    if (!isSystemEventActor(event.actor) && !event.consumedByStepKey) {
      queued.set(event.type, (queued.get(event.type) ?? 0) + 1);
    }
  }

  const stepsByKey = new Map(steps.map((step) => [step.stepKey, step]));
  const pending = new Set<string>();
  for (const step of steps) {
    const eventType = step.waitEventType;
    if (
      step.status !== "waiting" ||
      step.type !== "waitForEvent" ||
      !eventType ||
      isAbandonedWorkflowStep(step.stepKey, stepsByKey)
    ) {
      continue;
    }
    const available = queued.get(eventType) ?? 0;
    if (available > 0) {
      queued.set(eventType, available - 1);
    } else {
      pending.add(eventType);
    }
  }
  return [...pending];
}

/**
 * Whether a step was abandoned: an ancestor of it already completed or errored, as when a step
 * finishes without awaiting it, so the run never returns to it.
 */
export function isAbandonedWorkflowStep(
  stepKey: string,
  stepsByKey: ReadonlyMap<string, { parentStepKey: string | null; status: string }>,
): boolean {
  let parentStepKey = stepsByKey.get(stepKey)?.parentStepKey ?? parentKeyFromIdentity(stepKey);
  const visited = new Set<string>();

  while (parentStepKey && !visited.has(parentStepKey)) {
    visited.add(parentStepKey);
    const parent = stepsByKey.get(parentStepKey);
    if (parent && TERMINAL_STEP_STATUSES.has(parent.status)) {
      return true;
    }
    parentStepKey = parent?.parentStepKey ?? parentKeyFromIdentity(parentStepKey);
  }
  return false;
}

// `steps` may lack an ancestor, such as a partial replica's; a step's key still names its parent.
function parentKeyFromIdentity(stepKey: string): string | null {
  try {
    return parseStepKey(stepKey).parentStepKey;
  } catch {
    return null;
  }
}
