import type { DatabaseAdapter } from "@fragno-dev/db";

import type { SupportedAdapter, AdapterContext } from "./adapters";
import { createTestDb, type TestDb, type TestUnitOfWorkFactory } from "./test-db";

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
 * Helper to create common test context methods from schema-bound unit-of-work factories.
 * This is used internally by adapter implementations to avoid code duplication.
 */
export function createCommonTestContextMethods(
  unitOfWorkFactories: Map<string | null, TestUnitOfWorkFactory>,
): InternalTestContextMethods {
  return {
    getDb: (namespace: string | null) => {
      const createUnitOfWork = unitOfWorkFactories.get(namespace);
      if (!createUnitOfWork) {
        throw new Error(`No schema registered for namespace: ${String(namespace)}`);
      }
      return createTestDb(createUnitOfWork);
    },
  };
}

/**
 * Complete test context combining base and adapter-specific functionality.
 */
export type TestContext<T extends SupportedAdapter> = BaseTestContext & AdapterContext<T>;
