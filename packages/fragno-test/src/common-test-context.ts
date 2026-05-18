import type { DatabaseAdapter, FragnoDatabase } from "@fragno-dev/db";

import type { SupportedAdapter, AdapterContext } from "./adapters";
import { createTestDb, type TestDb } from "./test-db";

/**
 * Base test context with common functionality across all adapters.
 */
export interface BaseTestContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly adapter: DatabaseAdapter<any>;
  resetDatabase: () => Promise<void>;
  cleanup: () => Promise<void>;
}

/**
 * Internal interface with getDb for adapter implementations.
 */
export interface InternalTestContextMethods {
  getDb: (namespace: string | null) => TestDb;
}

/**
 * Helper to create common test context methods from an ORM map.
 * This is used internally by adapter implementations to avoid code duplication.
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
 * Complete test context combining base and adapter-specific functionality.
 */
export type TestContext<T extends SupportedAdapter> = BaseTestContext & AdapterContext<T>;
