import type { AnySchema } from "@fragno-dev/db/schema";
import type {
  SupportedAdapter,
  AdapterContext,
  KyselySqliteAdapter,
  KyselyPgliteAdapter,
  DrizzlePgliteAdapter,
} from "./adapters";
import { withUnitOfWork, type IUnitOfWorkBase, type DatabaseAdapter } from "@fragno-dev/db";
import type { AbstractQuery } from "@fragno-dev/db/query";

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
  AdapterContext,
} from "./adapters";

// Re-export new builder-based database test utilities
export { buildDatabaseFragmentsTest, DatabaseFragmentsTestBuilder } from "./db-test";

/**
 * Base test context with common functionality across all adapters
 */
export interface BaseTestContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly adapter: DatabaseAdapter<any>;
  createUnitOfWork: (name?: string) => IUnitOfWorkBase;
  withUnitOfWork: <T>(fn: (uow: IUnitOfWorkBase) => Promise<T>) => Promise<T>;
  callService: <T>(fn: () => T | Promise<T>) => Promise<T>;
  resetDatabase: () => Promise<void>;
  cleanup: () => Promise<void>;
}

/**
 * Internal interface with getOrm for adapter implementations
 */
export interface InternalTestContextMethods {
  getOrm: <TSchema extends AnySchema>(namespace: string) => AbstractQuery<TSchema>;
  createUnitOfWork: (name?: string) => IUnitOfWorkBase;
  withUnitOfWork: <T>(fn: (uow: IUnitOfWorkBase) => Promise<T>) => Promise<T>;
  callService: <T>(fn: () => T | Promise<T>) => Promise<T>;
}

/**
 * Helper to create common test context methods from an ORM map
 * This is used internally by adapter implementations to avoid code duplication
 */
export function createCommonTestContextMethods(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ormMap: Map<string, AbstractQuery<any>>,
): InternalTestContextMethods {
  return {
    getOrm: <TSchema extends AnySchema>(namespace: string) => {
      const orm = ormMap.get(namespace);
      if (!orm) {
        throw new Error(`No ORM found for namespace: ${namespace}`);
      }
      return orm as AbstractQuery<TSchema>;
    },
    createUnitOfWork: (name?: string) => {
      // Use the first schema's ORM to create a base UOW
      const firstOrm = ormMap.values().next().value;
      if (!firstOrm) {
        throw new Error("No ORMs available to create UnitOfWork");
      }
      return firstOrm.createUnitOfWork(name);
    },
    withUnitOfWork: async <T>(fn: (uow: IUnitOfWorkBase) => Promise<T>) => {
      const firstOrm = ormMap.values().next().value;
      if (!firstOrm) {
        throw new Error("No ORMs available to create UnitOfWork");
      }
      const uow = firstOrm.createUnitOfWork();
      return withUnitOfWork(uow, async () => {
        return await fn(uow);
      });
    },
    callService: async <T>(fn: () => T | Promise<T>) => {
      const firstOrm = ormMap.values().next().value;
      if (!firstOrm) {
        throw new Error("No ORMs available to create UnitOfWork");
      }
      const uow = firstOrm.createUnitOfWork();
      return withUnitOfWork(uow, async () => {
        // Call the function to schedule operations (don't await yet)
        const resultPromise = fn();

        // Execute UOW phases
        await uow.executeRetrieve();
        await uow.executeMutations();

        // Now await the result
        return await resultPromise;
      });
    },
  };
}

/**
 * Complete test context combining base and adapter-specific functionality
 */
export type TestContext<T extends SupportedAdapter> = BaseTestContext & AdapterContext<T>;
