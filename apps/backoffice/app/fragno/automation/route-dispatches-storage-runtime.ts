import type { AutomationRouteDefinition } from "@fragno-dev/backoffice-api/v0/automation";
import { type AutomationEvent, automationEventRootId } from "@fragno-dev/backoffice-api/v0/events";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { DatabaseServiceContext } from "@fragno-dev/db";

import type { AutomationHookUnitOfWork } from "./internal-hooks";
import { automationFragmentSchema } from "./schema";

/**
 * What a matched route did with an event. Derived events also record the route in their own
 * causation; workflow runs, deliveries, agent notifications, and skips are only recorded here.
 */
export type AutomationRouteDispatchOutcome =
  | { kind: "workflow_started"; workflowName: string; instanceId: string }
  | { kind: "workflow_event_sent"; workflowName: string; instanceId: string; eventType: string }
  | { kind: "event_forwarded"; eventId: string; scope: BackofficeContextScope }
  | { kind: "event_reclassified"; eventId: string }
  | { kind: "agent_notified"; agentName: string }
  | { kind: "skipped"; reason: AutomationRouteDispatchSkipReason };

/**
 * `no_linked_external_sender`: a linked-user route only acts for an external sender linked to a
 * user, and the event had none. `workflow_instance_unresolved`: the route's target instance id
 * rendered empty. `caused_by_notified_agent`: the agent's own turns produced the event, and
 * notifying it would let the agent wake itself.
 */
export type AutomationRouteDispatchSkipReason =
  | "no_linked_external_sender"
  | "workflow_instance_unresolved"
  | "caused_by_notified_agent";

/**
 * Where a matched route stands. `failedAttempts` counts the attempts that threw; a completed route
 * keeps the count, so one that only acted after retries stays visible. `retrying` and `failed`
 * keep the last error; `failed` is final, because the error cannot be fixed by retrying or the
 * route ran out of attempts.
 */
export type AutomationRouteDispatchState =
  | { status: "pending" }
  | { status: "retrying"; failedAttempts: number; error: string }
  | { status: "completed"; outcome: AutomationRouteDispatchOutcome; failedAttempts: number }
  | { status: "failed"; failedAttempts: number; error: string };

type AutomationRouteDispatchStateColumns = {
  status: string;
  outcome: AutomationRouteDispatchOutcome | null;
  failedAttempts: number;
  error: string | null;
};

function routeDispatchStateColumns(
  state: AutomationRouteDispatchState,
): AutomationRouteDispatchStateColumns {
  switch (state.status) {
    case "pending":
      return { status: state.status, outcome: null, failedAttempts: 0, error: null };
    case "retrying":
    case "failed":
      return {
        status: state.status,
        outcome: null,
        failedAttempts: state.failedAttempts,
        error: state.error,
      };
    case "completed":
      return {
        status: state.status,
        outcome: state.outcome,
        failedAttempts: state.failedAttempts,
        error: null,
      };
  }
  throw new Error("Unsupported automation route dispatch state.");
}

/** Dispatch rows are only written through `routeDispatchStateColumns`, so their columns agree. */
export function readRouteDispatchState(
  row: AutomationRouteDispatchStateColumns,
): AutomationRouteDispatchState {
  switch (row.status) {
    case "pending":
      return { status: "pending" };
    case "retrying":
    case "failed":
      return { status: row.status, failedAttempts: row.failedAttempts, error: row.error! };
    case "completed":
      return { status: "completed", outcome: row.outcome!, failedAttempts: row.failedAttempts };
  }
  throw new Error(`Unknown automation route dispatch status '${row.status}'.`);
}

/** A settled route has acted or given up, so a replayed dispatch must not act again. */
export function isRouteDispatchSettled(state: AutomationRouteDispatchState): boolean {
  return state.status === "completed" || state.status === "failed";
}

type RouteDispatchSubject = {
  event: Pick<AutomationEvent, "id" | "causation">;
  route: Pick<AutomationRouteDefinition, "id" | "name">;
};

export function routeDispatchId({ event, route }: RouteDispatchSubject): string {
  // Both ids may contain colons; the route id's length says where it ends.
  return `${route.id.length}:${route.id}:${event.id}`;
}

/** Records that an event matched a route, before the route acts. */
export function recordMatchedRoute(uow: AutomationHookUnitOfWork, subject: RouteDispatchSubject) {
  uow.create("automation_route_dispatch", {
    id: routeDispatchId(subject),
    eventId: subject.event.id,
    rootEventId: automationEventRootId(subject.event),
    routeId: subject.route.id,
    routeName: subject.route.name,
    ...routeDispatchStateColumns({ status: "pending" }),
    dispatchedAt: uow.now(),
  });
}

type AutomationRouteDispatchServiceContext = DatabaseServiceContext<Record<string, never>>;

export const createAutomationRouteDispatchServices = (
  defineService: <TService>(
    service: TService & ThisType<AutomationRouteDispatchServiceContext>,
  ) => TService,
) =>
  defineService({
    /**
     * A replayed route, such as one whose completion committed before its hook did, keeps the
     * state it settled with first.
     */
    updateRouteDispatch({
      state,
      ...subject
    }: RouteDispatchSubject & {
      state: Exclude<AutomationRouteDispatchState, { status: "pending" }>;
    }) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("automation_route_dispatch", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", routeDispatchId(subject))),
          ),
        )
        .mutate(({ uow, retrieveResult: [row] }) => {
          if (!row) {
            throw new Error(
              `Automation route ${subject.route.id} has no dispatch for event ${subject.event.id}.`,
            );
          }
          if (isRouteDispatchSettled(readRouteDispatchState(row))) {
            return;
          }
          uow.update("automation_route_dispatch", row.id, (b) =>
            b.set(routeDispatchStateColumns(state)).check(),
          );
        })
        .build();
    },
  });
