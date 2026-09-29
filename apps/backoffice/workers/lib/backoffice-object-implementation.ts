import {
  createFragmentDurableObjectHost,
  type FragmentDurableObjectHost,
  type FragmentDurableObjectHostDefinition,
  type FragmentDurableObjectHostOperations,
} from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import type { DatabaseTransactionInstrumentation } from "@fragno-dev/db/transaction-instrumentation";

import type { BackofficeDatabaseAdapterFactory } from "@/backoffice-runtime/database-adapters";
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
 * Runtime-specific implementation used by an in-memory Backoffice object.
 *
 * Object behavior supplies fragment definitions while this implementation owns tracing, storage
 * lifecycle integration, and low-level Fragment host operations.
 */
export type BackofficeObjectImplementation = {
  fragmentDatabase: BackofficeObjectFragmentDatabase;
  createFragmentHost<TSource, TRuntime>(
    definition: FragmentDurableObjectHostDefinition<unknown, TSource, TRuntime>,
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

export type CreateBackofficeObjectImplementationOptions<TEnv> = {
  state: BackofficeObjectState;
  env: TEnv;
  adapters: BackofficeDatabaseAdapterFactory;
  instrumentation: BackofficeRuntimeInstrumentation;
  fragmentHostOperations?: FragmentDurableObjectHostOperations<TEnv>;
  configuredObjectLifecycle: BackofficeConfiguredObjectLifecycle;
};

/** Binds one runtime's infrastructure to the primitives consumed by an in-memory object. */
export function createBackofficeObjectImplementation<TEnv>(
  options: CreateBackofficeObjectImplementationOptions<TEnv>,
): BackofficeObjectImplementation {
  const fragmentDatabase: BackofficeObjectFragmentDatabase = {
    adapters: options.adapters,
    transactionInstrumentation: options.instrumentation.databaseTransactions,
  };

  return {
    fragmentDatabase,
    createFragmentHost<TSource, TRuntime>(
      definition: FragmentDurableObjectHostDefinition<unknown, TSource, TRuntime>,
    ) {
      return createFragmentDurableObjectHost({
        ...definition,
        state: options.state,
        env: options.env,
        durableHooksInstrumentation: options.instrumentation.durableHooks,
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
        durableHooksInstrumentation: options.instrumentation.durableHooks,
        initializationInstrumentation: options.instrumentation.fragmentInitialization,
        fragmentHostOperations: options.fragmentHostOperations,
      });
    },
    registerRuntimeRefresh(refresh) {
      options.configuredObjectLifecycle.registerRefresh(refresh);
    },
  };
}
