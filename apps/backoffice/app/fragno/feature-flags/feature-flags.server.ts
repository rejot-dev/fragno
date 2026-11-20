import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { StoredOverride } from "@/fragno/overrides/definition";
import { storedOverridesInScope } from "@/fragno/overrides/overrides.server";
import { resolveOverride, type OverrideStatus } from "@/fragno/overrides/resolve";

import { featureFlagDefinitions, type FeatureFlagKey } from "./definitions";

type FeatureFlagRuntime = Pick<BackofficeRuntimeServices, "config" | "objects">;

/** Whether a feature is on in a scope: the most specific override on its chain, or the default. */
export async function isFeatureEnabledInScope(
  runtime: FeatureFlagRuntime,
  scope: BackofficeContextScope,
  key: FeatureFlagKey,
): Promise<boolean> {
  return (await featureFlagInScope(runtime, scope, key)).value;
}

/** A flag resolved from the overrides already read for its scope's chain. */
export function resolveFeatureFlag(
  scope: BackofficeContextScope,
  key: FeatureFlagKey,
  stored: StoredOverride[],
): OverrideStatus<boolean> {
  const definition = featureFlagDefinitions[key];
  // Resolution parses every value with the flag's boolean schema.
  return resolveOverride({ kind: "feature-flag", key, definition }, scope, stored);
}

async function featureFlagInScope(
  runtime: FeatureFlagRuntime,
  scope: BackofficeContextScope,
  key: FeatureFlagKey,
): Promise<OverrideStatus<boolean>> {
  return resolveFeatureFlag(scope, key, await storedOverridesInScope(runtime, scope));
}
