import type { DurableHooksLostAlarm } from "@fragno-dev/db/dispatchers/cloudflare-do";
import {
  createFragmentDurableObjectHost,
  type FragmentDurableObjectHost,
  type FragmentDurableObjectHostDefinition,
  type FragmentDurableObjectHostOperations,
} from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import type { DurableHooksInstrumentation } from "@fragno-dev/db/hooks";
import type { DatabaseTransactionInstrumentation } from "@fragno-dev/db/transaction-instrumentation";

import {
  backofficeScopeFields,
  type BackofficeHostTelemetry,
  type BackofficeScopeFields,
  type BackofficeTelemetry,
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

/** A query and the values it binds. */
export type SqlQuery = { sql: string; params: (string | number | null)[] };

/** What running a query on an empty database showed: the columns it selects, or why it failed. */
export type SqlQueryCheck =
  | { kind: "ran"; columns: string[] }
  | { kind: "failed"; message: string };

/**
 * Runs each query on its own empty database that `schema` creates, keeping none of the query's
 * changes, so a query that writes or drops what it reads cannot change what later checks see.
 */
export type SqlQueryChecker = (
  schema: readonly string[],
  queries: readonly SqlQuery[],
) => Promise<SqlQueryCheck[]>;

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
  checkSqlQueries: SqlQueryChecker;
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
  /** Instruments the object whose scope monitoring names with `scope`. */
  instrumentation: (scope: BackofficeScopeFields) => BackofficeRuntimeInstrumentation;
  telemetry: BackofficeTelemetry;
  fragmentHostOperations?: FragmentDurableObjectHostOperations<TEnv>;
  configuredObjectLifecycle: BackofficeConfiguredObjectLifecycle;
  checkSqlQueries: SqlQueryChecker;
};

/** Binds one runtime's infrastructure to the primitives consumed by a Backoffice object. */
export function createBackofficeObjectImplementation<TEnv>(
  options: CreateBackofficeObjectImplementationOptions<TEnv>,
): BackofficeObjectImplementation {
  const scope = options.state.id.name ? decodeBackofficeObjectScope(options.state.id.name) : null;
  const instrumentation = options.instrumentation(backofficeScopeFields(scope));
  const fragmentDatabase: BackofficeObjectFragmentDatabase = {
    adapters: options.adapters,
    transactionInstrumentation: instrumentation.databaseTransactions,
  };
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
        ...reportHostObservations(definition, telemetry),
        state: options.state,
        env: options.env,
        durableHooksInstrumentation: reportDurableHooks(instrumentation.durableHooks, telemetry),
        initializationInstrumentation: instrumentation.fragmentInitialization,
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
        durableHooksInstrumentation: reportDurableHooks(instrumentation.durableHooks, telemetry),
        initializationInstrumentation: instrumentation.fragmentInitialization,
        fragmentHostOperations: options.fragmentHostOperations,
      });
    },
    registerRuntimeRefresh(refresh) {
      options.configuredObjectLifecycle.registerRefresh(refresh);
    },
    hostTelemetry,
    checkSqlQueries: options.checkSqlQueries,
  };
}

type HostObservers = Record<
  "onMigrationError" | "onDispatcherError" | "onProcessError",
  (error: unknown) => void | Promise<void>
> & { onLostAlarm: (alarm: DurableHooksLostAlarm) => void };

/** Reports the failures and lost alarms a host sees, then hands them to its own observers. */
function reportHostObservations(
  definition: Partial<HostObservers>,
  telemetry: BackofficeHostTelemetry,
): HostObservers {
  return {
    onLostAlarm: (alarm) => {
      telemetry.record({ kind: "durable-hooks-lost-alarm", alarm });
      definition.onLostAlarm?.(alarm);
    },
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

/**
 * Records every committed hook attempt outcome, and every hook re-queued after its attempt died, on
 * top of the runtime's own instrumentation.
 */
function reportDurableHooks(
  instrumentation: DurableHooksInstrumentation,
  telemetry: BackofficeHostTelemetry,
): DurableHooksInstrumentation {
  return {
    ...instrumentation,
    observeAttemptOutcome(attempt, outcome) {
      instrumentation.observeAttemptOutcome?.(attempt, outcome);
      telemetry.record({ kind: "durable-hook-attempt", attempt, outcome });
    },
    observeStuckProcessingHooks(stuck) {
      instrumentation.observeStuckProcessingHooks?.(stuck);
      telemetry.record({ kind: "durable-hooks-stuck-requeued", stuck });
    },
  };
}
