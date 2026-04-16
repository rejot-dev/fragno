import type { DatabaseAdapter, FragnoDatabase } from "@fragno-dev/db";

import type {
  SupportedAdapter,
  AdapterContext,
  KyselySqliteAdapter,
  KyselyPgliteAdapter,
  DrizzlePgliteAdapter,
  InMemoryAdapterConfig,
} from "./adapters";
import { createTestDb, type TestDb } from "./test-db";

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
export type { AnyFragmentResult } from "./db-test";
export { drainDurableHooks } from "./durable-hooks";
export type { DrainDurableHooksMode, DrainDurableHooksOptions } from "./durable-hooks";
export { createTestDb } from "./test-db";
export type { TestDb } from "./test-db";

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
 * Internal interface with getDb for adapter implementations
 */
export interface InternalTestContextMethods {
  getDb: (namespace: string | null) => TestDb;
}

/**
 * Helper to create common test context methods from an ORM map
 * This is used internally by adapter implementations to avoid code duplication
 */
export function createCommonTestContextMethods(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ormMap: Map<string | null, FragnoDatabase<any>>,
): InternalTestContextMethods {
  return {
    getDb: (namespace: string | null) =>
      createTestDb(() => {
        const orm = ormMap.get(namespace);
        if (!orm) {
          throw new Error(`No ORM found for namespace: ${String(namespace)}`);
        }
        return orm;
      }),
  };
}

/**
 * Complete test context combining base and adapter-specific functionality
 */
export type TestContext<T extends SupportedAdapter> = BaseTestContext & AdapterContext<T>;
