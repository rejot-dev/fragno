import type {
  BackofficeScopeFields,
  BackofficeTelemetry,
} from "@/backoffice-runtime/backoffice-telemetry";
import type { BackofficeStorageConfirmation } from "@/backoffice-runtime/runtime-instrumentation";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { createCloudflareDurableObjectRuntimeServices } from "@/backoffice-runtime/runtime-services";

import {
  noOpBackofficeConfiguredObjectLifecycle,
  type BackofficeObjectState,
} from "./backoffice-fragment-durable-object";
import { createBackofficeObjectImplementation } from "./backoffice-object-implementation";
import { createCloudflareDatabaseTransactionInstrumentation } from "./cloudflare-database-transaction-instrumentation";
import { createCloudflareDurableHooksInstrumentation } from "./cloudflare-durable-hooks-instrumentation";
import { createCloudflareFragmentInitializationInstrumentation } from "./cloudflare-fragment-initialization-instrumentation";
import { createCloudflarePostHogTelemetry } from "./cloudflare-posthog-telemetry";
import { observeCloudflareStorageConfirmation } from "./cloudflare-storage-confirmation";

function createCloudflareBackofficeRuntimeInstrumentation(scope: BackofficeScopeFields) {
  return {
    databaseTransactions: createCloudflareDatabaseTransactionInstrumentation(scope),
    durableHooks: createCloudflareDurableHooksInstrumentation(scope),
    fragmentInitialization: createCloudflareFragmentInitializationInstrumentation(scope),
    storageConfirmation: (
      storage: DurableObjectStorage,
      confirmation: BackofficeStorageConfirmation,
    ) => {
      observeCloudflareStorageConfirmation(storage, scope, confirmation);
    },
  };
}

export function createCloudflareBackofficeObjectImplementation(
  state: BackofficeObjectState,
  env: CloudflareEnv,
  runtime: BackofficeRuntimeServices,
  telemetry: BackofficeTelemetry,
) {
  return createBackofficeObjectImplementation({
    state,
    env,
    adapters: runtime.adapters,
    instrumentation: createCloudflareBackofficeRuntimeInstrumentation,
    telemetry,
    configuredObjectLifecycle: noOpBackofficeConfiguredObjectLifecycle,
  });
}

/** Creates the complete constructor input shared by Cloudflare Durable Object adapters. */
export function createCloudflareBackofficeObjectContext(
  state: DurableObjectState,
  env: CloudflareEnv,
) {
  const runtime = createCloudflareDurableObjectRuntimeServices(env, state);
  return {
    state,
    env,
    runtime,
    nowEpochMs: Date.now,
    implementation: createCloudflareBackofficeObjectImplementation(
      state,
      env,
      runtime,
      createCloudflarePostHogTelemetry(env, state),
    ),
  };
}
