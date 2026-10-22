import type { AutomationRouteDefinition } from "@fragno-dev/backoffice-api/v0/automation";
import {
  type AutomationEvent,
  type AutomationEventRouteDispatch,
  automationEventRootId,
  type AutomationRouteDispatchOutcome,
  type AutomationRouteDispatchState,
} from "@fragno-dev/backoffice-api/v0/events";

import type { DatabaseServiceContext } from "@fragno-dev/db";

import type { AutomationHookUnitOfWork } from "./internal-hooks";
import { automationFragmentSchema } from "./schema";

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
    /** The routes an event matched, by route id. */
    listEventRouteDispatches({ eventId }: { eventId: string }) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.find("automation_route_dispatch", (b) =>
            b.whereIndex("idx_automation_route_dispatch_eventId", (eb) =>
              eb("eventId", "=", eventId),
            ),
          ),
        )
        .transformRetrieve(([rows]) =>
          rows
            .map(
              (row): AutomationEventRouteDispatch => ({
                ...readRouteDispatchState(row),
                routeId: row.routeId,
                routeName: row.routeName,
                matchedAt: row.dispatchedAt.toISOString(),
              }),
            )
            .sort((left, right) => left.routeId.localeCompare(right.routeId)),
        )
        .build();
    },
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
