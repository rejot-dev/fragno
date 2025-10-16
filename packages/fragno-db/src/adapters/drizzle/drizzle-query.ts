import type { AbstractQuery } from "../../query/query";
import type { AnySchema } from "../../schema/create";
import type { DrizzleConfig } from "./drizzle-adapter";
import type { CompiledMutation, UOWExecutor } from "../../query/unit-of-work";
import { createDrizzleUOWCompiler, type DrizzleCompiledQuery } from "./drizzle-uow-compiler";
import { executeDrizzleRetrievalPhase, executeDrizzleMutationPhase } from "./drizzle-uow-executor";
import { UnitOfWork } from "../../query/unit-of-work";
import { parseDrizzle } from "./shared";
import { createDrizzleUOWDecoder } from "./drizzle-uow-decoder";

export interface DrizzleResult {
  rows: Record<string, unknown>[];
  affectedRows: number;
}

/**
 * Configuration options for creating a Drizzle Unit of Work
 */
export interface DrizzleUOWConfig {
  /**
   * Optional callback to receive compiled SQL queries for logging/debugging
   * This callback is invoked for each query as it's compiled
   */
  onQuery?: (query: DrizzleCompiledQuery) => void;
}

/**
 * Creates a Drizzle-based query engine for the given schema.
 *
 * This is the main entry point for creating a database query interface using Drizzle.
 * It uses a compiler-based architecture where queries are compiled to SQL and then executed,
 * enabling features like SQL snapshot testing.
 *
 * @param schema - The database schema definition
 * @param config - Drizzle configuration containing the database instance and provider
 * @returns An AbstractQuery instance for performing database operations
 *
 * @example
 * ```ts
 * const queryEngine = fromDrizzle(mySchema, {
 *   db: drizzle,
 *   provider: 'postgresql'
 * });
 *
 * const uow = queryEngine.createUnitOfWork('myOperation');
 * ```
 */
export function fromDrizzle<T extends AnySchema>(
  schema: T,
  config: DrizzleConfig,
): AbstractQuery<T, DrizzleUOWConfig> {
  const [db] = parseDrizzle(config.db);
  const { provider } = config;

  return {
    async count() {
      throw new Error("not implemented");
    },

    async findFirst() {
      throw new Error("not implemented");
    },

    async findMany() {
      throw new Error("not implemented");
    },

    async create() {
      throw new Error("not implemented");
    },

    async createMany() {
      throw new Error("not implemented");
    },

    async updateMany() {
      throw new Error("not implemented");
    },

    async deleteMany() {
      throw new Error("not implemented");
    },

    createUnitOfWork(name, uowConfig) {
      // Create compiler with optional callback from config
      const uowCompiler = createDrizzleUOWCompiler(schema, config, uowConfig?.onQuery);

      const executor: UOWExecutor<DrizzleCompiledQuery, DrizzleResult> = {
        executeRetrievalPhase: (retrievalBatch: DrizzleCompiledQuery[]) =>
          executeDrizzleRetrievalPhase(db, retrievalBatch),
        executeMutationPhase: (mutationBatch: CompiledMutation<DrizzleCompiledQuery>[]) =>
          executeDrizzleMutationPhase(db, mutationBatch),
      };

      // Create a decoder function to transform raw results into application format
      const decoder = createDrizzleUOWDecoder(schema, provider);

      return new UnitOfWork(schema, uowCompiler, executor, decoder, name);
    },
  } as AbstractQuery<T, DrizzleUOWConfig>;
}
