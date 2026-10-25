import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import { ledgerFragmentDefinition } from "./definition";
import { ledgerRoutesFactory } from "./routes";

export function createLedgerFragment(options: FragnoPublicConfigWithDatabase) {
  return instantiate(ledgerFragmentDefinition)
    .withConfig({})
    .withRoutes([ledgerRoutesFactory])
    .withOptions(options)
    .build();
}
