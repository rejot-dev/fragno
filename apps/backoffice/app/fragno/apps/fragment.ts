import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import { appsFragmentDefinition } from "./definition";

/** No HTTP routes are exposed until Auth-backed management entry points exist. */
export function createAppsFragment(options: FragnoPublicConfigWithDatabase) {
  return instantiate(appsFragmentDefinition)
    .withConfig({})
    .withRoutes([])
    .withOptions(options)
    .build();
}

export type AppsFragment = ReturnType<typeof createAppsFragment>;
