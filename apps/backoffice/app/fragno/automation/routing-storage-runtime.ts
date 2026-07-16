import type { DatabaseServiceContext } from "@fragno-dev/db";

import type { AutomationInternalHooks } from "./internal-hooks";
import { normalizeAutomationRoute } from "./route-records";
import {
  AUTOMATION_SCHEDULE_EVENT_TYPE,
  AUTOMATION_SCHEDULE_SOURCE,
  automationScheduleCadencesEqual,
  validateAutomationScheduleCadence,
} from "./route-triggers";
import {
  automationRouteCreateInputSchema,
  automationRouteUpdateInputSchema,
  type AutomationRouteCreateInput,
  type AutomationRouteUpdateInput,
} from "./routing-schemas";
import { automationFragmentSchema } from "./schema";

type AutomationRouteServiceContext = DatabaseServiceContext<AutomationInternalHooks>;

const authoredRouteEqual = (
  left: {
    name: string;
    enabled: boolean;
    priority: number;
    trigger: unknown;
    action: unknown;
    description?: string | null;
  },
  right: {
    name: string;
    enabled: boolean;
    priority: number;
    trigger: unknown;
    action: unknown;
    description?: string | null;
  },
) =>
  left.name === right.name &&
  left.enabled === right.enabled &&
  left.priority === right.priority &&
  JSON.stringify(left.trigger) === JSON.stringify(right.trigger) &&
  JSON.stringify(left.action) === JSON.stringify(right.action) &&
  (left.description ?? null) === (right.description ?? null);

export const createAutomationRouteServices = (
  defineService: <TService>(
    service: TService & ThisType<AutomationRouteServiceContext>,
  ) => TService,
) =>
  defineService({
    listRoutes() {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow
            .find("automation_route", (b) =>
              b.whereIndex("primary").orderByIndex("idx_automation_route_priority_id", "asc"),
            )
            .find("automation_route_schedule_state", (b) => b.whereIndex("primary")),
        )
        .transformRetrieve(([routes, scheduleStates]) => {
          const stateByRouteId = new Map(
            scheduleStates.map((state) => [state.id.externalId, state] as const),
          );
          return routes.map((route) =>
            normalizeAutomationRoute(route, stateByRouteId.get(route.id.externalId)),
          );
        })
        .build();
    },

    getRoute({ id }: { id: string }) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow
            .findFirst("automation_route", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", id)),
            )
            .findFirst("automation_route_schedule_state", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", id)),
            ),
        )
        .transformRetrieve(([route, scheduleState]) =>
          route ? normalizeAutomationRoute(route, scheduleState) : null,
        )
        .build();
    },

    createRoute(input: AutomationRouteCreateInput) {
      const route = automationRouteCreateInputSchema.parse(input);
      if (route.trigger.kind === "schedule") {
        validateAutomationScheduleCadence(route.trigger.cadence);
      }

      return this.serviceTx(automationFragmentSchema)
        .mutate(({ uow }) => {
          uow.create("automation_route", {
            id: route.id,
            name: route.name,
            enabled: route.enabled,
            priority: route.priority,
            trigger: route.trigger,
            action: route.action,
            description: route.description ?? null,
            createdAt: uow.now(),
            updatedAt: uow.now(),
          });

          if (route.trigger.kind === "schedule") {
            uow.create("automation_route_schedule_state", {
              id: route.id,
              initializationAt: route.enabled ? uow.now() : null,
              nextOccurrenceAt: null,
            });
            if (route.enabled) {
              uow.triggerHook(
                "internalDispatchRouteSchedule",
                { kind: "initialize", routeId: route.id },
                { processAt: uow.now() },
              );
            }
          }

          return { ...route, nextOccurrenceAt: null };
        })
        .transform(({ mutateResult }) => mutateResult)
        .build();
    },

    updateRoute(input: AutomationRouteUpdateInput) {
      const patch = automationRouteUpdateInputSchema.parse(input);
      if (patch.trigger?.kind === "schedule") {
        validateAutomationScheduleCadence(patch.trigger.cadence);
      }

      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow
            .findFirst("automation_route", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", patch.id)),
            )
            .findFirst("automation_route_schedule_state", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", patch.id)),
            ),
        )
        .mutate(({ uow, retrieveResult: [existing, scheduleState] }) => {
          if (!existing) {
            return null;
          }

          const current = normalizeAutomationRoute(existing, scheduleState);
          const merged = {
            id: current.id,
            name: patch.name ?? current.name,
            enabled: patch.enabled ?? current.enabled,
            priority: patch.priority ?? current.priority,
            trigger: patch.trigger ?? current.trigger,
            action: patch.action ?? current.action,
            description:
              "description" in patch ? (patch.description ?? null) : (current.description ?? null),
          };
          if (authoredRouteEqual(current, merged)) {
            return current;
          }

          const wasScheduled = current.trigger.kind === "schedule";
          const isScheduled = merged.trigger.kind === "schedule";
          if (wasScheduled && !scheduleState) {
            throw new Error(`Scheduled automation route ${current.id} has no scheduling state.`);
          }

          const cadenceChanged =
            current.trigger.kind === "schedule" &&
            merged.trigger.kind === "schedule" &&
            !automationScheduleCadencesEqual(current.trigger.cadence, merged.trigger.cadence);
          const needsInitialization =
            isScheduled && merged.enabled && (!wasScheduled || !current.enabled || cadenceChanged);

          uow.update("automation_route", existing.id, (b) =>
            b
              .set({
                name: merged.name,
                enabled: merged.enabled,
                priority: merged.priority,
                trigger: merged.trigger,
                action: merged.action,
                description: merged.description,
                updatedAt: uow.now(),
              })
              .check(),
          );

          if (!wasScheduled && isScheduled) {
            uow.create("automation_route_schedule_state", {
              id: current.id,
              initializationAt: needsInitialization ? uow.now() : null,
              nextOccurrenceAt: null,
            });
          } else if (wasScheduled && !isScheduled) {
            uow.delete("automation_route_schedule_state", scheduleState!.id, (b) => b.check());
          } else if (wasScheduled && isScheduled && (!merged.enabled || needsInitialization)) {
            uow.update("automation_route_schedule_state", scheduleState!.id, (b) =>
              b
                .set({
                  initializationAt: needsInitialization ? uow.now() : null,
                  nextOccurrenceAt: null,
                })
                .check(),
            );
          }

          if (needsInitialization) {
            uow.triggerHook(
              "internalDispatchRouteSchedule",
              { kind: "initialize", routeId: current.id },
              { processAt: uow.now() },
            );
          }

          return {
            ...merged,
            nextOccurrenceAt:
              isScheduled && merged.enabled && !needsInitialization
                ? current.nextOccurrenceAt
                : null,
          };
        })
        .transform(({ mutateResult }) => mutateResult)
        .build();
    },

    deleteRoute({ id }: { id: string }) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow
            .findFirst("automation_route", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", id)),
            )
            .findFirst("automation_route_schedule_state", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", id)),
            ),
        )
        .mutate(({ uow, retrieveResult: [route, scheduleState] }) => {
          if (scheduleState) {
            uow.delete("automation_route_schedule_state", scheduleState.id, (b) => b.check());
          }
          if (route) {
            uow.delete("automation_route", route.id, (b) => b.check());
          }
          return true as const;
        })
        .transform(({ mutateResult }) => mutateResult)
        .build();
    },

    triggerScheduledRouteNow({ id }: { id: string }) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow
            .findFirst("automation_route", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", id)),
            )
            .findFirst("automation_route_schedule_state", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", id)),
            ),
        )
        .mutate(({ uow, retrieveResult: [row, scheduleState] }) => {
          if (!row) {
            return { kind: "missing" as const };
          }

          const route = normalizeAutomationRoute(row, scheduleState);
          if (route.trigger.kind !== "schedule") {
            return { kind: "not-scheduled" as const };
          }

          const eventId = `schedule:${route.id}:manual:${crypto.randomUUID()}`;
          uow.triggerHook(
            "internalDispatchRouteSchedule",
            { kind: "manual", eventId, route },
            { id: `manual-dispatch:${eventId}` },
          );

          return {
            kind: "accepted" as const,
            eventId,
            source: AUTOMATION_SCHEDULE_SOURCE,
            eventType: AUTOMATION_SCHEDULE_EVENT_TYPE,
          };
        })
        .transform(({ mutateResult }) => mutateResult)
        .build();
    },
  });
