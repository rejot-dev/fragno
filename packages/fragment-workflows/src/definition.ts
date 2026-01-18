import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import { workflowsSchema } from "./schema";

export const workflowsFragmentDefinition = defineFragment("workflows")
  .extend(withDatabase(workflowsSchema))
  .build();
