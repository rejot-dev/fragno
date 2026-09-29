import type { FragmentDurableObjectHostOperations } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";

import type {
  BackofficeConfiguredObjectLifecycle,
  BackofficeObjectState,
} from "../../../workers/lib/backoffice-fragment-durable-object";
import {
  createBackofficeObjectImplementation,
  type BackofficeObjectImplementation,
} from "../../../workers/lib/backoffice-object-implementation";
import type { BackofficeRuntimeEnv } from "../backoffice-runtime-env";
import type { BackofficeRuntimeServices } from "../runtime-services";
import { nodeBackofficeRuntimeInstrumentation } from "./node-runtime-instrumentation";

export function createNodeBackofficeObjectImplementation(options: {
  state: BackofficeObjectState;
  env: BackofficeRuntimeEnv;
  runtime: BackofficeRuntimeServices;
  fragmentHostOperations?: FragmentDurableObjectHostOperations<BackofficeRuntimeEnv>;
  configuredObjectLifecycle: BackofficeConfiguredObjectLifecycle;
}): BackofficeObjectImplementation {
  return createBackofficeObjectImplementation({
    state: options.state,
    env: options.env,
    adapters: options.runtime.adapters,
    instrumentation: nodeBackofficeRuntimeInstrumentation,
    fragmentHostOperations: options.fragmentHostOperations,
    configuredObjectLifecycle: options.configuredObjectLifecycle,
  });
}
