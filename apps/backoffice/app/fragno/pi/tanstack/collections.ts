import { piSchema } from "@fragno-dev/pi-harness/schema";
import type { FragnoOutboxCoordinator } from "@fragno-dev/tanstack-db-adapter/coordinator";
import { workflowsSchema } from "@fragno-dev/workflows/schema";

import type { FragnoCollection, FragnoCollectionFactory } from "@fragno-dev/tanstack-db-adapter";

export type PiCollectionTarget =
  | "pi-harness.session"
  | "workflows.workflow_instance"
  | "workflows.workflow_step"
  | "workflows.workflow_step_emission";

export type PiCollections = {
  sessions: FragnoCollection<typeof piSchema, "session">;
  workflowInstances: FragnoCollection<typeof workflowsSchema, "workflow_instance">;
  workflowSteps: FragnoCollection<typeof workflowsSchema, "workflow_step">;
  workflowStepEmissions: FragnoCollection<typeof workflowsSchema, "workflow_step_emission">;
};

export function createPiCollections(options: {
  coordinator: FragnoOutboxCoordinator;
  collectionId(target: PiCollectionTarget): string;
  createCollection: FragnoCollectionFactory;
}): PiCollections {
  return {
    sessions: options.createCollection({
      id: options.collectionId("pi-harness.session"),
      coordinator: options.coordinator,
      target: {
        schema: piSchema,
        table: "session",
      },
    }),
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
