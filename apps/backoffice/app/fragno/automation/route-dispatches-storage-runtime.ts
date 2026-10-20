import type { AutomationRouteDefinition } from "@fragno-dev/backoffice-api/v0/automation";
import { type AutomationEvent, automationEventRootId } from "@fragno-dev/backoffice-api/v0/events";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { DatabaseServiceContext } from "@fragno-dev/db";

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

type AutomationRouteDispatchServiceContext = DatabaseServiceContext<Record<string, never>>;

export const createAutomationRouteDispatchServices = (
  defineService: <TService>(
    service: TService & ThisType<AutomationRouteDispatchServiceContext>,
  ) => TService,
) =>
  defineService({
    /**
     * Ingestion hooks replay every matched route until all of them succeed, so a route that
     * already acted keeps its first record.
     */
    recordRouteDispatch({
      event,
      route,
      outcome,
    }: {
      event: Pick<AutomationEvent, "id" | "causation">;
      route: Pick<AutomationRouteDefinition, "id" | "name">;
      outcome: AutomationRouteDispatchOutcome;
    }) {
      // Both ids may contain colons; the route id's length says where it ends.
      const id = `${route.id.length}:${route.id}:${event.id}`;
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("automation_route_dispatch", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", id)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing] }) => {
          if (existing) {
            return;
          }
          uow.create("automation_route_dispatch", {
            id,
            eventId: event.id,
            rootEventId: automationEventRootId(event),
            routeId: route.id,
            routeName: route.name,
            outcome,
            dispatchedAt: uow.now(),
          });
        })
        .build();
    },
  });
