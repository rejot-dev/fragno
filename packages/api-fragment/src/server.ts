import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import { apiFragmentDefinition, type ApiFragmentConfig } from "./definition";
import { apiRoutesFactory } from "./routes";

const apiRoutes = [apiRoutesFactory] as const;

export function createApiFragment(
  config: ApiFragmentConfig,
  fragnoConfig: FragnoPublicConfigWithDatabase,
) {
  return instantiate(apiFragmentDefinition)
    .withConfig(config)
    .withRoutes(apiRoutes)
    .withOptions(fragnoConfig)
    .build();
}
