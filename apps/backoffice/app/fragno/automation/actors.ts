import {
  type AutomationActors,
  automationActorsSchema,
} from "@fragno-dev/backoffice-api/v0/automation";
import { z } from "zod";

export const BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY = "__backofficeActors";

export type BackofficeWorkflowActorMetadata = {
  [BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY]: AutomationActors;
};

export const backofficeWorkflowActorMetadataSchema = z.strictObject({
  [BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY]: automationActorsSchema,
});

export const AUTOMATION_SYSTEM_INITIATOR = {
  scope: "internal",
  type: "system",
  id: "backoffice",
  role: "initiator",
} as const satisfies AutomationActors["initiator"];
