import type { AnyTable } from "@fragno-dev/db/schema";
import { workflowsSchema } from "@fragno-dev/workflows/schema";

import {
  type FragnoCollectionRow,
  type FragnoOutboxCoordinator,
} from "@fragno-dev/tanstack-db-adapter";

import type { Collection } from "@tanstack/react-db";

import {
  createPiAgentCollections,
  type PiAgentRecord,
  type PiAgentTurnRecord,
} from "@/fragno/pi/agent/pi-agent-records";
import {
  createIntegrationConnectionsCollection,
  type IntegrationConnectionRecord,
} from "@/fragno/runtime-tools/families/integrations/integration-connections";

import { automationFragmentSchema } from "../schema";
import { createWorkflowWaitsCollection, type WorkflowWaitRecord } from "./workflow-waits";

type TableCollection<TTable extends AnyTable> = Collection<FragnoCollectionRow<TTable>, string>;

/** The collections that mirror the scope's synchronized tables. */
export type AutomationTableCollections = {
  kvStore: TableCollection<(typeof automationFragmentSchema.tables)["kv_store"]>;
  projects: TableCollection<(typeof automationFragmentSchema.tables)["project"]>;
  routes: TableCollection<(typeof automationFragmentSchema.tables)["automation_route"]>;
  routeScheduleStates: TableCollection<
    (typeof automationFragmentSchema.tables)["automation_route_schedule_state"]
  >;
  events: TableCollection<(typeof automationFragmentSchema.tables)["automation_event"]>;
  routeDispatches: TableCollection<
    (typeof automationFragmentSchema.tables)["automation_route_dispatch"]
  >;
  eventSources: TableCollection<
    (typeof automationFragmentSchema.tables)["automation_event_source"]
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

/** The rows Backoffice derives from the synchronized tables, by collection. */
export type AutomationDerivedRows = {
  connections: IntegrationConnectionRecord;
  agents: PiAgentRecord;
  agentTurns: PiAgentTurnRecord;
  workflowWaits: WorkflowWaitRecord;
};

/** The synchronized tables, and what Backoffice derives from them. */
export type AutomationCollections = AutomationTableCollections & {
  [TCollection in keyof AutomationDerivedRows]: Collection<
    AutomationDerivedRows[TCollection],
    string
  >;
};

type AutomationCoordinator = FragnoOutboxCoordinator<
  readonly [typeof automationFragmentSchema, typeof workflowsSchema]
>;

export function createAutomationCollections(
  coordinator: AutomationCoordinator,
): AutomationCollections {
  const tables = createAutomationTableCollections(coordinator);
  return {
    ...tables,
    connections: createIntegrationConnectionsCollection(tables),
    ...createPiAgentCollections(tables),
    workflowWaits: createWorkflowWaitsCollection(tables),
  };
}

function createAutomationTableCollections(
  coordinator: AutomationCoordinator,
): AutomationTableCollections {
  return {
    kvStore: coordinator.collection(automationFragmentSchema, "kv_store"),
    projects: coordinator.collection(automationFragmentSchema, "project"),
    routes: coordinator.collection(automationFragmentSchema, "automation_route"),
    routeScheduleStates: coordinator.collection(
      automationFragmentSchema,
      "automation_route_schedule_state",
    ),
    events: coordinator.collection(automationFragmentSchema, "automation_event"),
    routeDispatches: coordinator.collection(automationFragmentSchema, "automation_route_dispatch"),
    eventSources: coordinator.collection(automationFragmentSchema, "automation_event_source"),
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
