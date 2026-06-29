import type { DatabaseServiceContext } from "@fragno-dev/db";

import type { AutomationRouteDefinition } from "./routing";
import {
  automationRouteCreateInputSchema,
  automationRouteUpdateInputSchema,
  type AutomationRouteCreateInput,
  type AutomationRouteUpdateInput,
} from "./routing-schemas";
import { automationFragmentSchema } from "./schema";

type AutomationRouteServiceContext = DatabaseServiceContext<Record<string, never>>;

const mergeRouteUpdate = ({
  existing,
  patch,
}: {
  existing: AutomationRouteDefinition;
  patch: AutomationRouteUpdateInput;
}): AutomationRouteDefinition => ({
  id: existing.id,
  name: patch.name ?? existing.name,
  enabled: patch.enabled ?? existing.enabled,
  source: patch.source ?? existing.source,
  eventType: patch.eventType ?? existing.eventType,
  matcher: typeof patch.matcher === "undefined" ? existing.matcher : patch.matcher,
  action: patch.action ?? existing.action,
  priority: patch.priority ?? existing.priority,
  description:
    "description" in patch ? (patch.description ?? null) : (existing.description ?? null),
});

export const createAutomationRouteServices = (
  defineService: <TService>(
    service: TService & ThisType<AutomationRouteServiceContext>,
  ) => TService,
) =>
  defineService({
    listRoutes() {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.find("automation_route", (b) =>
            b.whereIndex("primary").orderByIndex("idx_automation_route_priority_id", "asc"),
          ),
        )
        .transformRetrieve(([routes]) =>
          routes.map((route) => ({
            id: route.id.externalId,
            name: route.name,
            enabled: route.enabled,
            source: route.source,
            eventType: route.eventType,
            matcher: route.matcher,
            action: route.action,
            priority: route.priority,
            description: route.description,
          })),
        )
        .build();
    },

    getRoute({ id }: { id: string }) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("automation_route", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", id)),
          ),
        )
        .transformRetrieve(([route]) =>
          route
            ? {
                id: route.id.externalId,
                name: route.name,
                enabled: route.enabled,
                source: route.source,
                eventType: route.eventType,
                matcher: route.matcher,
                action: route.action,
                priority: route.priority,
                description: route.description,
              }
            : null,
        )
        .build();
    },

    createRoute(input: AutomationRouteCreateInput) {
      const route = automationRouteCreateInputSchema.parse(input);

      return this.serviceTx(automationFragmentSchema)
        .mutate(({ uow }) => {
          const now = uow.now();
          uow.create("automation_route", {
            id: route.id,
            name: route.name,
            enabled: route.enabled,
            source: route.source,
            eventType: route.eventType,
            matcher: route.matcher,
            action: route.action,
            priority: route.priority,
            description: route.description ?? null,
            createdAt: now,
            updatedAt: now,
          });

          return route;
        })
        .transform(({ mutateResult }) => mutateResult)
        .build();
    },

    updateRoute(input: AutomationRouteUpdateInput) {
      const patch = automationRouteUpdateInputSchema.parse(input);

      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("automation_route", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", patch.id)),
          ),
        )
        .mutate(({ uow, retrieveResult: [rawExisting] }) => {
          if (!rawExisting) {
            return null;
          }

          const route = mergeRouteUpdate({
            existing: {
              id: rawExisting.id.externalId,
              name: rawExisting.name,
              enabled: rawExisting.enabled,
              source: rawExisting.source,
              eventType: rawExisting.eventType,
              matcher: rawExisting.matcher,
              action: rawExisting.action,
              priority: rawExisting.priority,
              description: rawExisting.description,
            },
            patch,
          });
          uow.update("automation_route", rawExisting.id, (b) =>
            b
              .set({
                name: route.name,
                enabled: route.enabled,
                source: route.source,
                eventType: route.eventType,
                matcher: route.matcher,
                action: route.action,
                priority: route.priority,
                description: route.description ?? null,
                updatedAt: uow.now(),
              })
              .check(),
          );

          return route;
        })
        .transform(({ mutateResult }) => mutateResult)
        .build();
    },
  });
