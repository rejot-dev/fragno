import type { FragnoOutboxCoordinator } from "@fragno-dev/tanstack-db-adapter/coordinator";
import { workflowsSchema } from "@fragno-dev/workflows/schema";

import type { FragnoCollection, FragnoCollectionFactory } from "@fragno-dev/tanstack-db-adapter";

import { automationFragmentSchema } from "../schema";

type AutomationTableName = keyof (typeof automationFragmentSchema)["tables"];

export type AutomationCollectionTarget =
  | AutomationTableName
  | "workflows.workflow_instance"
  | "workflows.workflow_step"
  | "workflows.workflow_event"
  | "workflows.workflow_step_emission";

export type AutomationCollections = {
  kvStore: FragnoCollection<typeof automationFragmentSchema, "kv_store">;
  sandboxInstances: FragnoCollection<typeof automationFragmentSchema, "sandbox_instance">;
  routes: FragnoCollection<typeof automationFragmentSchema, "automation_route">;
  routeScheduleStates: FragnoCollection<
    typeof automationFragmentSchema,
    "automation_route_schedule_state"
  >;
  events: FragnoCollection<typeof automationFragmentSchema, "automation_event">;
  marketplaceIngestions: FragnoCollection<typeof automationFragmentSchema, "marketplace_ingestion">;
  eventDefinitions: FragnoCollection<
    typeof automationFragmentSchema,
    "automation_event_definition"
  >;
  externalIdentityBindings: FragnoCollection<
    typeof automationFragmentSchema,
    "external_identity_binding"
  >;
  workflowInstances: FragnoCollection<typeof workflowsSchema, "workflow_instance">;
  workflowSteps: FragnoCollection<typeof workflowsSchema, "workflow_step">;
  workflowEvents: FragnoCollection<typeof workflowsSchema, "workflow_event">;
  workflowStepEmissions: FragnoCollection<typeof workflowsSchema, "workflow_step_emission">;
};

export function createAutomationCollections(options: {
  coordinator: FragnoOutboxCoordinator;
  collectionId(target: AutomationCollectionTarget): string;
  createCollection: FragnoCollectionFactory;
}): AutomationCollections {
  const createAutomationTableCollection = <TTableName extends AutomationTableName>(
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
    kvStore: createAutomationTableCollection("kv_store"),
    sandboxInstances: createAutomationTableCollection("sandbox_instance"),
    routes: createAutomationTableCollection("automation_route"),
    routeScheduleStates: createAutomationTableCollection("automation_route_schedule_state"),
    events: createAutomationTableCollection("automation_event"),
    marketplaceIngestions: createAutomationTableCollection("marketplace_ingestion"),
    eventDefinitions: createAutomationTableCollection("automation_event_definition"),
    externalIdentityBindings: createAutomationTableCollection("external_identity_binding"),
    workflowInstances: options.createCollection({
      id: options.collectionId("workflows.workflow_instance"),
      coordinator: options.coordinator,
      target: {
        schema: workflowsSchema,
        table: "workflow_instance",
      },
    }),
    workflowSteps: options.createCollection({
      id: options.collectionId("workflows.workflow_step"),
      coordinator: options.coordinator,
      target: {
        schema: workflowsSchema,
        table: "workflow_step",
      },
    }),
    workflowEvents: options.createCollection({
      id: options.collectionId("workflows.workflow_event"),
      coordinator: options.coordinator,
      target: {
        schema: workflowsSchema,
        table: "workflow_event",
      },
    }),
    workflowStepEmissions: options.createCollection({
      id: options.collectionId("workflows.workflow_step_emission"),
      coordinator: options.coordinator,
      target: {
        schema: workflowsSchema,
        table: "workflow_step_emission",
      },
    }),
  };
}
