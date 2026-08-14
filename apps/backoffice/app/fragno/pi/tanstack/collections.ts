import { workflowsSchema } from "@fragno-dev/workflows/schema";

import {
  type FragnoCollectionRow,
  type FragnoOutboxCoordinator,
} from "@fragno-dev/tanstack-db-adapter";

import type { Collection } from "@tanstack/react-db";

export type PiCollectionTarget =
  | "workflows.workflow_instance"
  | "workflows.workflow_step"
  | "workflows.workflow_step_emission";

export type PiCollections = {
  workflowInstances: Collection<
    FragnoCollectionRow<(typeof workflowsSchema.tables)["workflow_instance"]>,
    string
  >;
  workflowSteps: Collection<
    FragnoCollectionRow<(typeof workflowsSchema.tables)["workflow_step"]>,
    string
  >;
  workflowStepEmissions: Collection<
    FragnoCollectionRow<(typeof workflowsSchema.tables)["workflow_step_emission"]>,
    string
  >;
};

export function createPiCollections(
  coordinator: FragnoOutboxCoordinator<readonly [typeof workflowsSchema]>,
): PiCollections {
  return {
    workflowInstances: coordinator.collection(workflowsSchema, "workflow_instance"),
    workflowSteps: coordinator.collection(workflowsSchema, "workflow_step"),
    workflowStepEmissions: coordinator.collection(workflowsSchema, "workflow_step_emission", {
      rowUpdateMode: "full",
      skipMissingTruncateDeletes: true,
    }),
  };
}
