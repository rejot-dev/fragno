import {
  createFragmentDurableObjectHost,
  type FragmentDurableObjectHost,
  type FragmentDurableObjectHostDefinition,
  type FragmentDurableObjectHostOperations,
} from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import type { DurableHooksInstrumentation } from "@fragno-dev/db/hooks";
import type { DatabaseTransactionInstrumentation } from "@fragno-dev/db/transaction-instrumentation";

import type {
  BackofficeHostTelemetry,
  BackofficeTelemetry,
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
  /**
   * Reports signals as the host named `host`. Hosts already report their hook attempts and errors;
   * runtimes use this for their own outcomes, such as finished workflows.
   */
  hostTelemetry(host: string): BackofficeHostTelemetry;
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
  const scope = options.state.id.name ? decodeBackofficeObjectScope(options.state.id.name) : null;
  const hostTelemetry = (host: string): BackofficeHostTelemetry => ({
    record(signal) {
      options.telemetry.record({ ...signal, object: { host, scope } });
    },
  });

  return {
    fragmentDatabase,
    createFragmentHost<TSource, TRuntime>(
      definition: NamedFragmentHostDefinition<TSource, TRuntime>,
    ) {
      const telemetry = hostTelemetry(definition.name);
      return createFragmentDurableObjectHost({
        ...definition,
        ...reportHostErrors(definition, telemetry),
        state: options.state,
        env: options.env,
        durableHooksInstrumentation: reportDurableHookAttempts(
          options.instrumentation.durableHooks,
          telemetry,
        ),
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
      const telemetry = hostTelemetry(definition.name);
      return createBackofficeFragmentDurableObject<TStored, TSource, TRuntime, TOutbox, TEnv>({
        ...definition,
        state: options.state,
        env: options.env,
        configuredObjectLifecycle: options.configuredObjectLifecycle,
        telemetry,
        durableHooksInstrumentation: reportDurableHookAttempts(
          options.instrumentation.durableHooks,
          telemetry,
        ),
        initializationInstrumentation: options.instrumentation.fragmentInitialization,
        fragmentHostOperations: options.fragmentHostOperations,
      });
    },
    registerRuntimeRefresh(refresh) {
      options.configuredObjectLifecycle.registerRefresh(refresh);
    },
    hostTelemetry,
  };
}

type HostErrorObservers = Record<
  "onMigrationError" | "onDispatcherError" | "onProcessError",
  (error: unknown) => void | Promise<void>
>;

/** Reports the failures a host sees, then hands them to the host's own observers. */
function reportHostErrors(
  definition: Partial<HostErrorObservers>,
  telemetry: BackofficeHostTelemetry,
): HostErrorObservers {
  return {
    onMigrationError: async (error) => {
      telemetry.record({ kind: "host-error", stage: "migration", error });
      await definition.onMigrationError?.(error);
    },
    onDispatcherError: async (error) => {
      telemetry.record({ kind: "host-error", stage: "dispatcher", error });
      await definition.onDispatcherError?.(error);
    },
    onProcessError: async (error) => {
      telemetry.record({ kind: "host-error", stage: "hook-processor", error });
      await definition.onProcessError?.(error);
    },
  };
}

/** Records every committed hook attempt outcome on top of the runtime's own instrumentation. */
function reportDurableHookAttempts(
  instrumentation: DurableHooksInstrumentation,
  telemetry: BackofficeHostTelemetry,
): DurableHooksInstrumentation {
  return {
    ...instrumentation,
    observeAttemptOutcome(attempt, outcome) {
      instrumentation.observeAttemptOutcome?.(attempt, outcome);
      telemetry.record({ kind: "durable-hook-attempt", attempt, outcome });
    },
  };
}
