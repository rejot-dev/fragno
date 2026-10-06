import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import { appInstallationsFragmentDefinition, type AppInstallationsConfig } from "./definition";

/** No HTTP routes are exposed until Auth-backed organization management entry points exist. */
export function createAppInstallationsFragment(
  config: AppInstallationsConfig,
  options: FragnoPublicConfigWithDatabase,
) {
  return instantiate(appInstallationsFragmentDefinition)
    .withConfig(config)
    .withRoutes([])
    .withOptions(options)
    .build();
}

/** A fragment instance belongs to exactly one organization's object. */
export type AppInstallationsFragment = ReturnType<typeof createAppInstallationsFragment>;
