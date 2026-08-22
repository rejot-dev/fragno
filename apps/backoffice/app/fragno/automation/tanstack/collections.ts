import type { AnyTable } from "@fragno-dev/db/schema";
import { workflowsSchema } from "@fragno-dev/workflows/schema";

import {
  type FragnoCollectionRow,
  type FragnoOutboxCoordinator,
} from "@fragno-dev/tanstack-db-adapter";

import type { Collection } from "@tanstack/react-db";

import { automationFragmentSchema } from "../schema";

type TableCollection<TTable extends AnyTable> = Collection<FragnoCollectionRow<TTable>, string>;

export type AutomationCollections = {
  kvStore: TableCollection<(typeof automationFragmentSchema.tables)["kv_store"]>;
  projects: TableCollection<(typeof automationFragmentSchema.tables)["project"]>;
  sandboxInstances: TableCollection<(typeof automationFragmentSchema.tables)["sandbox_instance"]>;
  routes: TableCollection<(typeof automationFragmentSchema.tables)["automation_route"]>;
  routeScheduleStates: TableCollection<
    (typeof automationFragmentSchema.tables)["automation_route_schedule_state"]
  >;
  events: TableCollection<(typeof automationFragmentSchema.tables)["automation_event"]>;
  eventSources: TableCollection<
    (typeof automationFragmentSchema.tables)["automation_event_source"]
  >;
  marketplaceIngestions: TableCollection<
    (typeof automationFragmentSchema.tables)["marketplace_ingestion"]
  >;
  eventDefinitions: TableCollection<
    (typeof automationFragmentSchema.tables)["automation_event_definition"]
  >;
  externalIdentityBindings: TableCollection<
    (typeof automationFragmentSchema.tables)["external_identity_binding"]
  >;
  workflowInstances: TableCollection<(typeof workflowsSchema.tables)["workflow_instance"]>;
  workflowSteps: TableCollection<(typeof workflowsSchema.tables)["workflow_step"]>;
  workflowEvents: TableCollection<(typeof workflowsSchema.tables)["workflow_event"]>;
  workflowStepEmissions: TableCollection<(typeof workflowsSchema.tables)["workflow_step_emission"]>;
};

type AutomationCoordinator = FragnoOutboxCoordinator<
  readonly [typeof automationFragmentSchema, typeof workflowsSchema]
>;

export function createAutomationCollections(
  coordinator: AutomationCoordinator,
): AutomationCollections {
  return {
    kvStore: coordinator.collection(automationFragmentSchema, "kv_store"),
    projects: coordinator.collection(automationFragmentSchema, "project"),
    sandboxInstances: coordinator.collection(automationFragmentSchema, "sandbox_instance"),
    routes: coordinator.collection(automationFragmentSchema, "automation_route"),
    routeScheduleStates: coordinator.collection(
      automationFragmentSchema,
      "automation_route_schedule_state",
    ),
    events: coordinator.collection(automationFragmentSchema, "automation_event"),
    eventSources: coordinator.collection(automationFragmentSchema, "automation_event_source"),
    marketplaceIngestions: coordinator.collection(
      automationFragmentSchema,
      "marketplace_ingestion",
    ),
    eventDefinitions: coordinator.collection(
      automationFragmentSchema,
      "automation_event_definition",
    ),
    externalIdentityBindings: coordinator.collection(
      automationFragmentSchema,
      "external_identity_binding",
    ),
    workflowInstances: coordinator.collection(workflowsSchema, "workflow_instance"),
    workflowSteps: coordinator.collection(workflowsSchema, "workflow_step"),
    workflowEvents: coordinator.collection(workflowsSchema, "workflow_event"),
    workflowStepEmissions: coordinator.collection(workflowsSchema, "workflow_step_emission", {
      rowUpdateMode: "full",
      skipMissingTruncateDeletes: true,
    }),
  };
}
