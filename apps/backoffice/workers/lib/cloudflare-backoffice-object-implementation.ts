import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { createCloudflareDurableObjectRuntimeServices } from "@/backoffice-runtime/runtime-services";

import {
  noOpBackofficeConfiguredObjectLifecycle,
  type BackofficeObjectState,
} from "./backoffice-fragment-durable-object";
import { createBackofficeObjectImplementation } from "./backoffice-object-implementation";
import { cloudflareDatabaseTransactionInstrumentation } from "./cloudflare-database-transaction-instrumentation";
import { cloudflareDurableHooksInstrumentation } from "./cloudflare-durable-hooks-instrumentation";
import { cloudflareFragmentInitializationInstrumentation } from "./cloudflare-fragment-initialization-instrumentation";

const cloudflareBackofficeRuntimeInstrumentation = {
  databaseTransactions: cloudflareDatabaseTransactionInstrumentation,
  durableHooks: cloudflareDurableHooksInstrumentation,
  fragmentInitialization: cloudflareFragmentInitializationInstrumentation,
};

export function createCloudflareBackofficeObjectImplementation(
  state: BackofficeObjectState,
  env: CloudflareEnv,
  runtime: BackofficeRuntimeServices,
) {
  return createBackofficeObjectImplementation({
    state,
    env,
    adapters: runtime.adapters,
    instrumentation: cloudflareBackofficeRuntimeInstrumentation,
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
    implementation: createCloudflareBackofficeObjectImplementation(state, env, runtime),
  };
}
