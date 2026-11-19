import {
  backofficeScopeOrganization,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";

import { featureFlagDefinitions, type FeatureFlagKey } from "./contracts";

export async function isOrganizationFeatureEnabled(
  runtime: BackofficeRuntimeServices,
  scope: BackofficeContextScope,
  key: FeatureFlagKey,
): Promise<boolean> {
  const organization = backofficeScopeOrganization(scope);
  if (!organization) {
    return false;
  }
  if (!runtime.config.bindings.featureFlags) {
    return featureFlagDefinitions[key].defaultEnabled;
  }
  return (await runtime.objects.featureFlags.for(organization).commands.getFlag(key)).enabled;
}
