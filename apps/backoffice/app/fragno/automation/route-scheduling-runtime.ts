import type { DatabaseHandlerTx } from "@fragno-dev/db";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";

import type { AutomationEvent } from "./contracts";
import type {
  AutomationHookUnitOfWork,
  AutomationInternalHooks,
  AutomationRouteScheduleDispatchPayload,
} from "./internal-hooks";
import { normalizeAutomationRoute } from "./route-records";
import {
  AUTOMATION_SCHEDULE_EVENT_TYPE,
  AUTOMATION_SCHEDULE_SOURCE,
  nextAutomationScheduleOccurrence,
} from "./route-triggers";
import type { AutomationRouteDefinition } from "./routing";
import { automationFragmentSchema } from "./schema";

/**
 * Scheduled route timing is anchored exclusively to database time:
 *
 * 1. Creating, re-enabling, or changing a scheduled trigger stores `initializationAt` with
 *    `uow.now()`, leaves `nextOccurrenceAt` null, and queues an immediate initialization hook.
 * 2. The hook reads that materialized timestamp and calculates the first occurrence.
 * 3. After each recurring occurrence, its dispatch stores a new `initializationAt` with `uow.now()`
 *    and queues the initialization hook again. Re-anchoring to dispatch time coalesces missed cron
 *    occurrences instead of replaying an unbounded backlog.
 * 4. Disabling, deleting, or changing the trigger invalidates queued hooks through route and state
 *    checks.
 *
 * Manual triggers snapshot the route in their hook payload and use the hook's database-generated
 * `createdAt` as the occurrence time, so accepted triggers survive later route updates or deletion.
 */
const buildScheduledRouteEvent = ({
  route,
  scope,
  scheduledFor,
}: {
  route: AutomationRouteDefinition;
  scope: BackofficeContextScope;
  scheduledFor: Date;
}): AutomationEvent => {
  if (route.trigger.kind !== "schedule") {
    throw new Error(`Automation route ${route.id} does not have a scheduled trigger.`);
  }

  const actor = {
    scope: "internal" as const,
    type: "schedule",
    id: route.id,
    role: "initiator",
  };
  return {
    id: `schedule:${route.id}:${scheduledFor.getTime()}`,
    scope,
    source: AUTOMATION_SCHEDULE_SOURCE,
    eventType: AUTOMATION_SCHEDULE_EVENT_TYPE,
    occurredAt: scheduledFor.toISOString(),
    payload: {
      id: route.id,
      name: route.name,
      cadence: route.trigger.cadence,
    },
    actor,
    actors: [actor],
    subject:
      scope.kind === "org" || scope.kind === "project"
        ? {
            orgId: scope.orgId,
            ...(scope.kind === "project" ? { projectId: scope.projectId } : {}),
          }
        : scope.kind === "user"
          ? { userId: scope.userId }
          : null,
  };
};

const initializeScheduledRoute = async ({
  routeId,
  handlerTx,
}: {
  routeId: string;
  handlerTx: DatabaseHandlerTx<AutomationInternalHooks>;
}) => {
  await handlerTx()
    .retrieve(({ forSchema }) => {
      const uow = forSchema(automationFragmentSchema);
      return uow
        .findFirst("automation_route", (b) =>
          b.whereIndex("primary", (eb) => eb("id", "=", routeId)),
        )
        .findFirst("automation_route_schedule_state", (b) =>
          b.whereIndex("primary", (eb) => eb("id", "=", routeId)),
        );
    })
    .mutate(({ forSchema, retrieveResult: [route, state] }) => {
      if (!route || !route.enabled || route.trigger.kind !== "schedule") {
        return;
      }
      if (!state) {
        throw new Error(`Scheduled automation route ${routeId} has no scheduling state.`);
      }
      if (state.nextOccurrenceAt) {
        return;
      }
      if (!state.initializationAt) {
        if (route.trigger.cadence.kind === "once") {
          return;
        }
        throw new Error(
          `Enabled cron route ${routeId} has neither an initialization timestamp nor a next occurrence.`,
        );
      }

      const initializationAt = state.initializationAt;
      const nextOccurrenceAt = nextAutomationScheduleOccurrence(
        route.trigger.cadence,
        initializationAt,
      );
      const uow = forSchema(automationFragmentSchema);
      if (!nextOccurrenceAt) {
        if (route.trigger.cadence.kind === "once") {
          uow.update("automation_route_schedule_state", state.id, (b) =>
            b.set({ initializationAt: null, nextOccurrenceAt: null }).check(),
          );
          return;
        }
        throw new Error(`Scheduled automation route ${routeId} could not be initialized.`);
      }
      if (Number.isNaN(nextOccurrenceAt.getTime())) {
        throw new Error(`Scheduled automation route ${routeId} could not be initialized.`);
      }

      uow.update("automation_route_schedule_state", state.id, (b) =>
        b.set({ initializationAt: null, nextOccurrenceAt }).check(),
      );
      uow.triggerHook(
        "internalDispatchRouteSchedule",
        { kind: "dispatch", routeId, scheduledFor: nextOccurrenceAt.toISOString() },
        { processAt: nextOccurrenceAt },
      );
    })
    .execute();
};

const dispatchScheduledRouteOccurrence = async ({
  payload,
  ownerScope,
  ingestEvent,
  handlerTx,
}: {
  payload: Extract<AutomationRouteScheduleDispatchPayload, { kind: "dispatch" }>;
  ownerScope: BackofficeContextScope;
  ingestEvent: (
    uow: AutomationHookUnitOfWork,
    event: AutomationEvent,
    options: { route: AutomationRouteDefinition },
  ) => void;
  handlerTx: DatabaseHandlerTx<AutomationInternalHooks>;
}) => {
  await handlerTx()
    .retrieve(({ forSchema }) => {
      const uow = forSchema(automationFragmentSchema);
      return uow
        .findFirst("automation_route", (b) =>
          b.whereIndex("primary", (eb) => eb("id", "=", payload.routeId)),
        )
        .findFirst("automation_route_schedule_state", (b) =>
          b.whereIndex("primary", (eb) => eb("id", "=", payload.routeId)),
        );
    })
    .mutate(({ forSchema, retrieveResult: [row, state] }) => {
      if (!row || !row.enabled || row.trigger.kind !== "schedule") {
        return;
      }
      if (!state) {
        throw new Error(`Scheduled automation route ${payload.routeId} has no scheduling state.`);
      }

      const persistedNextOccurrence = state.nextOccurrenceAt?.toISOString() ?? null;
      if (persistedNextOccurrence !== payload.scheduledFor) {
        return;
      }

      const route = normalizeAutomationRoute(row, state);
      const scheduledFor = new Date(payload.scheduledFor);
      const uow = forSchema(automationFragmentSchema);
      ingestEvent(uow, buildScheduledRouteEvent({ route, scope: ownerScope, scheduledFor }), {
        route,
      });

      if (row.trigger.cadence.kind === "once") {
        uow.update("automation_route_schedule_state", state.id, (b) =>
          b.set({ initializationAt: null, nextOccurrenceAt: null }).check(),
        );
        return;
      }

      const initializationAt = uow.now();
      uow.update("automation_route_schedule_state", state.id, (b) =>
        b.set({ initializationAt, nextOccurrenceAt: null }).check(),
      );
      uow.triggerHook(
        "internalDispatchRouteSchedule",
        { kind: "initialize", routeId: route.id },
        { processAt: initializationAt },
      );
    })
    .execute();
};

const dispatchManualScheduledRouteTrigger = async ({
  payload,
  requestedAt,
  ownerScope,
  ingestEvent,
  handlerTx,
}: {
  payload: Extract<AutomationRouteScheduleDispatchPayload, { kind: "manual" }>;
  requestedAt: Date;
  ownerScope: BackofficeContextScope;
  ingestEvent: (
    uow: AutomationHookUnitOfWork,
    event: AutomationEvent,
    options: { route: AutomationRouteDefinition },
  ) => void;
  handlerTx: DatabaseHandlerTx<AutomationInternalHooks>;
}) => {
  await handlerTx()
    .retrieve(({ forSchema }) =>
      forSchema(automationFragmentSchema).findFirst("automation_event", (b) =>
        b.whereIndex("primary", (eb) => eb("id", "=", payload.eventId)),
      ),
    )
    .mutate(({ forSchema, retrieveResult: [existingEvent] }) => {
      // Hook completion is recorded separately from event ingestion. A retry after the event commit
      // observes the event and completes without emitting or executing the route twice. Stuck-hook
      // recovery can overlap a still-running handler; the unique event ID allows only one commit,
      // while the loser completes through this check on its next retry.
      if (existingEvent) {
        return;
      }

      const uow = forSchema(automationFragmentSchema);
      ingestEvent(
        uow,
        {
          ...buildScheduledRouteEvent({
            route: payload.route,
            scope: ownerScope,
            scheduledFor: requestedAt,
          }),
          id: payload.eventId,
        },
        { route: payload.route },
      );
    })
    .execute();
};

export const dispatchAutomationRouteSchedule = async ({
  payload,
  hookCreatedAt,
  ownerScope,
  ingestEvent,
  handlerTx,
}: {
  payload: AutomationRouteScheduleDispatchPayload;
  hookCreatedAt: Date;
  ownerScope: BackofficeContextScope;
  ingestEvent: (
    uow: AutomationHookUnitOfWork,
    event: AutomationEvent,
    options: { route: AutomationRouteDefinition },
  ) => void;
  handlerTx: DatabaseHandlerTx<AutomationInternalHooks>;
}) => {
  switch (payload.kind) {
    case "initialize":
      return await initializeScheduledRoute({ routeId: payload.routeId, handlerTx });
    case "dispatch":
      return await dispatchScheduledRouteOccurrence({
        payload,
        ownerScope,
        ingestEvent,
        handlerTx,
      });
    case "manual":
      return await dispatchManualScheduledRouteTrigger({
        payload,
        requestedAt: hookCreatedAt,
        ownerScope,
        ingestEvent,
        handlerTx,
      });
  }
};
