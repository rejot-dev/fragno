import type { AnySchema } from "@fragno-dev/db/schema";
import type {
  SupportedAdapter,
  AdapterContext,
  KyselySqliteAdapter,
  KyselyPgliteAdapter,
  DrizzlePgliteAdapter,
  InMemoryAdapterConfig,
} from "./adapters";
import type { DatabaseAdapter } from "@fragno-dev/db";
import type { SimpleQueryInterface } from "@fragno-dev/db/query";

// Re-export utilities from @fragno-dev/core/test
export {
  createFragmentForTest,
  type CreateFragmentForTestOptions,
  type RouteHandlerInputOptions,
} from "@fragno-dev/core/test";

// Re-export adapter types
export type {
  SupportedAdapter,
  KyselySqliteAdapter,
  KyselyPgliteAdapter,
  DrizzlePgliteAdapter,
  InMemoryAdapterConfig,
  AdapterContext,
} from "./adapters";

// Re-export new builder-based database test utilities
export { buildDatabaseFragmentsTest, DatabaseFragmentsTestBuilder } from "./db-test";
export {
  runModelChecker,
  defaultStateHasher,
  defaultTraceHasher,
  type ModelCheckerConfig,
  type ModelCheckerBounds,
  type ModelCheckerRunResult,
  type ModelCheckerScheduleResult,
  type ModelCheckerMode,
  type ModelCheckerStep,
  type ModelCheckerTraceEvent,
  type ModelCheckerTrace,
  type ModelCheckerTraceRecorder,
  type ModelCheckerTraceHasher,
  type ModelCheckerTraceHashMode,
  type NormalizedMutationOperation,
  type RawUowTransaction,
  type RawUowTransactionBuilder,
  type RawUowTransactionContext,
  type RawUowMutateContext,
  createRawUowTransaction,
} from "./model-checker";

export {
  runModelCheckerWithActors,
  type ModelCheckerActor,
  type ModelCheckerInvariant,
  type ModelCheckerInvariantContext,
  type ModelCheckerActorsConfig,
} from "./model-checker-actors";

export { ModelCheckerAdapter, type ModelCheckerScheduler } from "./model-checker-adapter";

/**
 * Base test context with common functionality across all adapters
 */
export interface BaseTestContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly adapter: DatabaseAdapter<any>;
  resetDatabase: () => Promise<void>;
  cleanup: () => Promise<void>;
}

/**
 * Internal interface with getOrm for adapter implementations
 */
export interface InternalTestContextMethods {
  getOrm: <TSchema extends AnySchema>(namespace: string) => SimpleQueryInterface<TSchema>;
}

/**
 * Helper to create common test context methods from an ORM map
 * This is used internally by adapter implementations to avoid code duplication
 */
export function createCommonTestContextMethods(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ormMap: Map<string, SimpleQueryInterface<any>>,
): InternalTestContextMethods {
  return {
    getOrm: <TSchema extends AnySchema>(namespace: string) => {
      const orm = ormMap.get(namespace);
      if (!orm) {
        throw new Error(`No ORM found for namespace: ${namespace}`);
      }
      return orm as SimpleQueryInterface<TSchema>;
    },
  };
}

/**
 * Complete test context combining base and adapter-specific functionality
 */
export type TestContext<T extends SupportedAdapter> = BaseTestContext & AdapterContext<T>;
