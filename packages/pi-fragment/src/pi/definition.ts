import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";

import { piSchema } from "../schema";
import type { PiFragmentConfig, PiWorkflowsService } from "./types";

export const piFragmentDefinition = defineFragment<PiFragmentConfig>("pi-fragment")
  .extend(withDatabase(piSchema))
  .usesService<"workflows", PiWorkflowsService>("workflows")
  .build();
