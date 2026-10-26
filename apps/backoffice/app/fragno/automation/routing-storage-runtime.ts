import {
  type AutomationActors,
  type AutomationRouteAction,
  automationRouteCreateInputSchema,
  automationRouteUpdateInputSchema,
  type AutomationRouteCreateInput,
  type AutomationSteward,
  type AutomationRouteUpdateInput,
} from "@fragno-dev/backoffice-api/v0/automation";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { DatabaseServiceContext } from "@fragno-dev/db";

import type { AutomationInternalHooks } from "./internal-hooks";
import { legacyMarketplaceRouteListingId, normalizeAutomationRoute } from "./route-records";
import {
  AUTOMATION_SCHEDULE_EVENT_TYPE,
  AUTOMATION_SCHEDULE_SOURCE,
  automationScheduleCadencesEqual,
  validateAutomationScheduleCadence,
} from "./route-triggers";
import {
  assertAutomationRouteAuthorityMatchesScope,
  assertAutomationRouteDoesNotReclassifyItself,
} from "./routing";
import { automationFragmentSchema } from "./schema";
import { assertStewardWrite, stewardsEqual } from "./stewards";

type AutomationRouteServiceContext = DatabaseServiceContext<AutomationInternalHooks>;

export type AuthorizeAutomationRouteAction = (input: {
  routeId: string;
  action: AutomationRouteAction;
}) => Promise<void>;

const authoredRouteEqual = (
  left: {
    name: string;
    enabled: boolean;
    priority: number;
    trigger: unknown;
    action: unknown;
    description?: string | null;
    steward: AutomationSteward;
  },
  right: {
    name: string;
    enabled: boolean;
    priority: number;
    trigger: unknown;
    action: unknown;
    description?: string | null;
    steward: AutomationSteward;
  },
) =>
  left.name === right.name &&
  left.enabled === right.enabled &&
  left.priority === right.priority &&
  JSON.stringify(left.trigger) === JSON.stringify(right.trigger) &&
  JSON.stringify(left.action) === JSON.stringify(right.action) &&
  (left.description ?? null) === (right.description ?? null) &&
  stewardsEqual(left.steward, right.steward);

export const createAutomationRouteServices = (
  defineService: <TService>(
    service: TService & ThisType<AutomationRouteServiceContext>,
  ) => TService,
  { ownerScope }: { ownerScope: BackofficeContextScope },
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

    /** The writer becomes the route's steward. */
    createRoute(
      input: AutomationRouteCreateInput,
      actors: AutomationActors,
      writer: AutomationSteward,
    ) {
      const route = automationRouteCreateInputSchema.parse(input);
      if (route.trigger.kind === "schedule") {
        validateAutomationScheduleCadence(route.trigger.cadence);
      }
      assertAutomationRouteAuthorityMatchesScope({
        ownerScope,
        trigger: route.trigger,
        action: route.action,
      });
      assertAutomationRouteDoesNotReclassifyItself({
        routeId: route.id,
        trigger: route.trigger,
        action: route.action,
      });

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
            metadata: { createdByActors: actors, updatedByActors: actors, steward: writer },
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

          return {
            ...route,
            description: route.description ?? null,
            steward: writer,
            metadata: { createdByActors: actors, updatedByActors: actors },
            nextOccurrenceAt: null,
          };
        })
        .transform(({ mutateResult }) => mutateResult)
        .build();
    },

    /** A package writer takes over a route it adopts; members' toggles keep the route's steward. */
    updateRoute(
      input: AutomationRouteUpdateInput,
      actors: AutomationActors,
      authorizeAction: AuthorizeAutomationRouteAction,
      writer: AutomationSteward,
    ) {
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
        .transformRetrieve(async ([existing, scheduleState]) => {
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
          const definitionChanged =
            merged.name !== current.name ||
            merged.priority !== current.priority ||
            JSON.stringify(merged.trigger) !== JSON.stringify(current.trigger) ||
            JSON.stringify(merged.action) !== JSON.stringify(current.action) ||
            merged.description !== (current.description ?? null);
          assertStewardWrite({
            resource: `Automation route '${current.id}'`,
            steward: current.steward,
            legacyListingId: legacyMarketplaceRouteListingId(existing),
            writer,
            definitionChanged,
          });
          // A package's write claims the route, even an adopted one whose definition already matches.
          const steward = definitionChanged || writer.kind === "package" ? writer : current.steward;
          const configurationChanged =
            JSON.stringify(merged.action) !== JSON.stringify(current.action) ||
            JSON.stringify(merged.trigger) !== JSON.stringify(current.trigger);
          if (configurationChanged || (merged.enabled && !current.enabled)) {
            assertAutomationRouteAuthorityMatchesScope({
              ownerScope,
              trigger: merged.trigger,
              action: merged.action,
            });
          }
          assertAutomationRouteDoesNotReclassifyItself({
            routeId: merged.id,
            trigger: merged.trigger,
            action: merged.action,
          });

          const unchanged = authoredRouteEqual(current, { ...merged, steward });
          const requiresGrantAuthorization =
            patch.action !== undefined ||
            patch.trigger !== undefined ||
            (patch.enabled === true && !current.enabled);
          if (!unchanged && requiresGrantAuthorization) {
            // Authorize the merged route inside the OCC attempt so a retry cannot commit different grants.
            await authorizeAction({ routeId: current.id, action: merged.action });
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

          return {
            existing,
            scheduleState,
            current,
            merged,
            steward,
            unchanged,
            wasScheduled,
            isScheduled,
            needsInitialization,
          };
        })
        .mutate(({ uow, retrieveResult: plan }) => {
          if (!plan) {
            return null;
          }

          const {
            existing,
            scheduleState,
            current,
            merged,
            steward,
            unchanged,
            wasScheduled,
            isScheduled,
            needsInitialization,
          } = plan;
          if (unchanged) {
            return current;
          }

          uow.update("automation_route", existing.id, (b) =>
            b
              .set({
                name: merged.name,
                enabled: merged.enabled,
                priority: merged.priority,
                trigger: merged.trigger,
                action: merged.action,
                description: merged.description,
                metadata: {
                  createdByActors: current.metadata?.createdByActors ?? actors,
                  updatedByActors: actors,
                  steward,
                },
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
            steward,
            metadata: {
              createdByActors: current.metadata?.createdByActors ?? actors,
              updatedByActors: actors,
            },
            nextOccurrenceAt:
              isScheduled && merged.enabled && !needsInitialization
                ? current.nextOccurrenceAt
                : null,
          };
        })
        .transform(({ mutateResult }) => mutateResult)
        .build();
    },

    deleteRoute({ id }: { id: string }, writer: AutomationSteward) {
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
          if (route) {
            assertStewardWrite({
              resource: `Automation route '${id}'`,
              steward: normalizeAutomationRoute(route, scheduleState).steward,
              legacyListingId: null,
              writer,
              definitionChanged: true,
            });
          }
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
