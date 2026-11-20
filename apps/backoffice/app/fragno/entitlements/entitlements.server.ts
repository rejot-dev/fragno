import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { overrideInScope } from "@/fragno/overrides/overrides.server";

import type { EntitlementKey, EntitlementValue } from "./definitions";

/** What an account may do in a scope: the most specific grant on its chain, or the default. */
export async function entitlementInScope<TKey extends EntitlementKey>(
  runtime: Pick<BackofficeRuntimeServices, "config" | "objects">,
  scope: BackofficeContextScope,
  key: TKey,
): Promise<EntitlementValue<TKey>> {
  // Resolution parses every value with the entitlement's own schema.
  return (await overrideInScope(runtime, { kind: "entitlement", key, scope }))
    .value as EntitlementValue<TKey>;
}
