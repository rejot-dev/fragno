import type { AutomationRouteDefinition } from "@fragno-dev/backoffice-api/v0/automation";
import {
  type AutomationEvent,
  type AutomationEventRouteDispatch,
  automationEventRootId,
  type AutomationRouteDispatchOutcome,
  type AutomationRouteDispatchState,
} from "@fragno-dev/backoffice-api/v0/events";

import type { Cursor, DatabaseServiceContext, TxResult } from "@fragno-dev/db";

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

/** Names both a route's dispatch row and the durable hook that runs the route. */
export function routeDispatchId({
  eventId,
  routeId,
}: {
  eventId: string;
  routeId: string;
}): string {
  // Both ids may contain colons; the route id's length says where it ends.
  return `${routeId.length}:${routeId}:${eventId}`;
}

function subjectDispatchId({ event, route }: RouteDispatchSubject): string {
  return routeDispatchId({ eventId: event.id, routeId: route.id });
}

/** The routes an event matched, as `events.get` and `events.list` return them. */
export function eventRouteDispatchesOfRows(
  rows: readonly Parameters<typeof routeDispatchOfRow>[0][],
): AutomationEventRouteDispatch[] {
  return rows
    .map(routeDispatchOfRow)
    .sort((left, right) => left.routeId.localeCompare(right.routeId));
}

function routeDispatchOfRow(row: {
  routeId: string;
  routeName: string;
  dispatchedAt: Date;
  status: string;
  outcome: AutomationRouteDispatchOutcome | null;
  failedAttempts: number;
  error: string | null;
}): AutomationEventRouteDispatch {
  return {
    ...readRouteDispatchState(row),
    routeId: row.routeId,
    routeName: row.routeName,
    matchedAt: row.dispatchedAt.toISOString(),
  };
}

/**
 * Whether a route was queued to act on its event again. `not_found` also covers a route whose hook
 * is gone, so no retry can run it.
 */
export type AutomationRouteRetry =
  | { status: "retried"; route: AutomationEventRouteDispatch }
  | { status: "not_failed" }
  | { status: "not_found" };

/** Records that an event matched a route, before the route acts. */
export function recordMatchedRoute(uow: AutomationHookUnitOfWork, subject: RouteDispatchSubject) {
  uow.create("automation_route_dispatch", {
    id: subjectDispatchId(subject),
    eventId: subject.event.id,
    rootEventId: automationEventRootId(subject.event),
    routeId: subject.route.id,
    routeName: subject.route.name,
    ...routeDispatchStateColumns({ status: "pending" }),
    dispatchedAt: uow.now(),
  });
}

type AutomationRouteDispatchServiceContext = DatabaseServiceContext<Record<string, never>>;

/** Cursors of `listRoutesWithStatus` name this index. */
export const ROUTES_BY_STATUS_INDEX = "idx_automation_route_dispatch_status_dispatchedAt";

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
        .transformRetrieve(([rows]) => eventRouteDispatchesOfRows(rows))
        .build();
    },
    /** The routes in `status`, each with the event it matched, by when it matched, newest first. */
    listRoutesWithStatus(input: {
      status: AutomationRouteDispatchState["status"];
      limit: number;
      cursor?: Cursor;
    }) {
      const { status, cursor } = input;
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findWithCursor("automation_route_dispatch", (b) => {
            const query = b
              .whereIndex(ROUTES_BY_STATUS_INDEX, (eb) => eb("status", "=", status))
              .orderByIndex(ROUTES_BY_STATUS_INDEX, "desc")
              .pageSize(cursor?.pageSize ?? input.limit);
            return cursor ? query.after(cursor) : query;
          }),
        )
        .transformRetrieve(([page]) => ({
          routes: page.items.map((row) => ({
            eventId: row.eventId,
            route: routeDispatchOfRow(row),
          })),
          cursor: page.cursor,
          hasNextPage: page.hasNextPage,
        }))
        .build();
    },
    /**
     * Runs a route that failed for good on an event again. `retryHook` queues the route's durable
     * hook again; the route reads as pending only when its hook will run, so a hook that already
     * runs or completed is left alone, even when recording its failure did not commit.
     */
    retryRouteDispatch<
      THookRetry,
      THookRetryIntent extends { status: "retried" | "not_failed" | "not_found" },
    >({
      eventId,
      routeId,
      retryHook,
    }: {
      eventId: string;
      routeId: string;
      retryHook: (hookId: string) => TxResult<THookRetry, THookRetryIntent>;
    }) {
      const id = routeDispatchId({ eventId, routeId });
      return this.serviceTx(automationFragmentSchema)
        .withServiceCalls(() => [retryHook(id)] as const)
        .retrieve((uow) =>
          uow.findFirst("automation_route_dispatch", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", id)),
          ),
        )
        .mutate(
          ({
            uow,
            retrieveResult: [row],
            serviceIntermediateResult: [hookRetry],
          }): AutomationRouteRetry => {
            if (!row || hookRetry.status === "not_found") {
              return { status: "not_found" };
            }
            if (hookRetry.status === "not_failed") {
              return { status: "not_failed" };
            }
            const pending = routeDispatchStateColumns({ status: "pending" });
            uow.update("automation_route_dispatch", row.id, (b) => b.set(pending).check());
            return { status: "retried", route: routeDispatchOfRow({ ...row, ...pending }) };
          },
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
            b.whereIndex("primary", (eb) => eb("id", "=", subjectDispatchId(subject))),
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
