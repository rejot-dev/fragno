import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import { accessCodesFragmentDefinition } from "./definition";

/** Its commands are the only way in, so it mounts no routes. */
export function createAccessCodesServer(
  options: Pick<FragnoPublicConfigWithDatabase, "databaseAdapter" | "transactionInstrumentation">,
) {
  return instantiate(accessCodesFragmentDefinition)
    .withConfig({})
    .withRoutes([])
    .withOptions({ ...options, mountRoute: "/api/access-codes" })
    .build();
}

export type AccessCodesFragment = ReturnType<typeof createAccessCodesServer>;
