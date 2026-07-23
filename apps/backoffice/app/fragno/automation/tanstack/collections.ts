import type { FragnoOutboxCoordinator } from "@fragno-dev/tanstack-db-adapter/coordinator";

import type { FragnoCollection, FragnoCollectionFactory } from "@fragno-dev/tanstack-db-adapter";

import { automationFragmentSchema } from "../schema";

export type AutomationCollections = {
  kvStore: FragnoCollection<typeof automationFragmentSchema, "kv_store">;
  sandboxInstances: FragnoCollection<typeof automationFragmentSchema, "sandbox_instance">;
  routes: FragnoCollection<typeof automationFragmentSchema, "automation_route">;
  routeScheduleStates: FragnoCollection<
    typeof automationFragmentSchema,
    "automation_route_schedule_state"
  >;
  events: FragnoCollection<typeof automationFragmentSchema, "automation_event">;
  eventDefinitions: FragnoCollection<
    typeof automationFragmentSchema,
    "automation_event_definition"
  >;
};

export type AutomationCollectionTarget = keyof (typeof automationFragmentSchema)["tables"];

export function createAutomationCollections(options: {
  coordinator: FragnoOutboxCoordinator;
  collectionId(table: AutomationCollectionTarget): string;
  createCollection: FragnoCollectionFactory;
}): AutomationCollections {
  const createTableCollection = <TTableName extends AutomationCollectionTarget>(
    table: TTableName,
  ) =>
    options.createCollection({
      id: options.collectionId(table),
      coordinator: options.coordinator,
      target: {
        schema: automationFragmentSchema,
        table,
      },
    });

  return {
    kvStore: createTableCollection("kv_store"),
    sandboxInstances: createTableCollection("sandbox_instance"),
    routes: createTableCollection("automation_route"),
    routeScheduleStates: createTableCollection("automation_route_schedule_state"),
    events: createTableCollection("automation_event"),
    eventDefinitions: createTableCollection("automation_event_definition"),
  };
}
