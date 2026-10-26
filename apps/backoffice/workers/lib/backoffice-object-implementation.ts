import {
  createFragmentDurableObjectHost,
  type FragmentDurableObjectHost,
  type FragmentDurableObjectHostDefinition,
  type FragmentDurableObjectHostOperations,
} from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import type { DurableHooksInstrumentation } from "@fragno-dev/db/hooks";
import type { DatabaseTransactionInstrumentation } from "@fragno-dev/db/transaction-instrumentation";

import type {
  BackofficeTelemetry,
  BackofficeTelemetryObject,
} from "@/backoffice-runtime/backoffice-telemetry";
import type { BackofficeDatabaseAdapterFactory } from "@/backoffice-runtime/database-adapters";
import { decodeBackofficeObjectScope } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeInstrumentation } from "@/backoffice-runtime/runtime-instrumentation";

import {
  createBackofficeFragmentDurableObject,
  type BackofficeFragmentDurableObject,
  type BackofficeConfiguredObjectLifecycle,
  type BackofficeFragmentDurableObjectDefinition,
  type BackofficeObjectState,
  type BackofficeOutboxItem,
} from "./backoffice-fragment-durable-object";

/** Database dependencies already bound to the current object and runtime implementation. */
export type BackofficeObjectFragmentDatabase = {
  adapters: BackofficeDatabaseAdapterFactory;
  transactionInstrumentation: DatabaseTransactionInstrumentation;
};

/**
 * Runtime-specific implementation used by a Backoffice object.
 *
 * Object behavior supplies fragment definitions while this implementation owns tracing, storage
 * lifecycle integration, and low-level Fragment host operations.
 */
export type BackofficeObjectImplementation = {
  fragmentDatabase: BackofficeObjectFragmentDatabase;
  createFragmentHost<TSource, TRuntime>(
    definition: NamedFragmentHostDefinition<TSource, TRuntime>,
  ): FragmentDurableObjectHost<TSource, TRuntime>;
  createConfiguredFragmentHost<
    TStored,
    TSource = TStored,
    TRuntime = never,
    TOutbox extends BackofficeOutboxItem = BackofficeOutboxItem,
  >(
    definition: BackofficeFragmentDurableObjectDefinition<
      TStored,
      TSource,
      TRuntime,
      TOutbox,
      unknown
    >,
  ): BackofficeFragmentDurableObject<TStored, TSource, TRuntime, TOutbox>;
  registerRuntimeRefresh(refresh: () => Promise<void>): void;
};

/** Telemetry names the host that reported a signal. */
type NamedFragmentHostDefinition<TSource, TRuntime> = FragmentDurableObjectHostDefinition<
  unknown,
  TSource,
  TRuntime
> & { name: string };

export type CreateBackofficeObjectImplementationOptions<TEnv> = {
  state: BackofficeObjectState;
  env: TEnv;
  adapters: BackofficeDatabaseAdapterFactory;
  instrumentation: BackofficeRuntimeInstrumentation;
  telemetry: BackofficeTelemetry;
  fragmentHostOperations?: FragmentDurableObjectHostOperations<TEnv>;
  configuredObjectLifecycle: BackofficeConfiguredObjectLifecycle;
};

/** Binds one runtime's infrastructure to the primitives consumed by a Backoffice object. */
export function createBackofficeObjectImplementation<TEnv>(
  options: CreateBackofficeObjectImplementationOptions<TEnv>,
): BackofficeObjectImplementation {
  const fragmentDatabase: BackofficeObjectFragmentDatabase = {
    adapters: options.adapters,
    transactionInstrumentation: options.instrumentation.databaseTransactions,
  };
  const durableHooksInstrumentation = (host: string) =>
    reportDurableHookAttempts(options.instrumentation.durableHooks, options.telemetry, {
      host,
      scope: options.state.id.name ? decodeBackofficeObjectScope(options.state.id.name) : null,
    });

  return {
    fragmentDatabase,
    createFragmentHost<TSource, TRuntime>(
      definition: NamedFragmentHostDefinition<TSource, TRuntime>,
    ) {
      return createFragmentDurableObjectHost({
        ...definition,
        state: options.state,
        env: options.env,
        durableHooksInstrumentation: durableHooksInstrumentation(definition.name),
        initializationInstrumentation: options.instrumentation.fragmentInitialization,
        operations: options.fragmentHostOperations,
      } as never) as unknown as FragmentDurableObjectHost<TSource, TRuntime>;
    },
    createConfiguredFragmentHost<
      TStored,
      TSource = TStored,
      TRuntime = never,
      TOutbox extends BackofficeOutboxItem = BackofficeOutboxItem,
    >(
      definition: BackofficeFragmentDurableObjectDefinition<
        TStored,
        TSource,
        TRuntime,
        TOutbox,
        unknown
      >,
    ) {
      return createBackofficeFragmentDurableObject<TStored, TSource, TRuntime, TOutbox, TEnv>({
        ...definition,
        state: options.state,
        env: options.env,
        configuredObjectLifecycle: options.configuredObjectLifecycle,
        durableHooksInstrumentation: durableHooksInstrumentation(definition.name),
        initializationInstrumentation: options.instrumentation.fragmentInitialization,
        fragmentHostOperations: options.fragmentHostOperations,
      });
    },
    registerRuntimeRefresh(refresh) {
      options.configuredObjectLifecycle.registerRefresh(refresh);
    },
  };
}

/** Records every committed hook attempt outcome on top of the runtime's own instrumentation. */
function reportDurableHookAttempts(
  instrumentation: DurableHooksInstrumentation,
  telemetry: BackofficeTelemetry,
  object: BackofficeTelemetryObject,
): DurableHooksInstrumentation {
  return {
    ...instrumentation,
    observeAttemptOutcome(attempt, outcome) {
      instrumentation.observeAttemptOutcome?.(attempt, outcome);
      telemetry.record({ kind: "durable-hook-attempt", object, attempt, outcome });
    },
  };
}
