import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import {
  sandboxManagerFragmentDefinition,
  type SandboxManagerFragmentConfig,
  type SandboxManagerWorkflowsService,
} from "./definition";

export function createSandboxManagerFragment(
  config: SandboxManagerFragmentConfig,
  options: FragnoPublicConfigWithDatabase,
  services: { workflows: SandboxManagerWorkflowsService },
) {
  return instantiate(sandboxManagerFragmentDefinition)
    .withConfig(config)
    .withRoutes([])
    .withOptions(options)
    .withServices(services)
    .build();
}
