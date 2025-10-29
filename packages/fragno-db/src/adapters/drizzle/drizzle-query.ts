import type { AbstractQuery } from "../../query/query";
import type { AnySchema } from "../../schema/create";
import type { CompiledMutation, UOWExecutor } from "../../query/unit-of-work";
import { createDrizzleUOWCompiler, type DrizzleCompiledQuery } from "./drizzle-uow-compiler";
import { executeDrizzleRetrievalPhase, executeDrizzleMutationPhase } from "./drizzle-uow-executor";
import { UnitOfWork } from "../../query/unit-of-work";
import { parseDrizzle, type DrizzleResult, type TableNameMapper, type DBType } from "./shared";
import { createDrizzleUOWDecoder } from "./drizzle-uow-decoder";
import type { ConnectionPool } from "../../shared/connection-pool";

/**
 * Configuration options for creating a Drizzle Unit of Work
 */
export interface DrizzleUOWConfig {
  /**
   * Optional callback to receive compiled SQL queries for logging/debugging
   * This callback is invoked for each query as it's compiled
   */
  onQuery?: (query: DrizzleCompiledQuery) => void;
  /**
   * If true, the query will not be executed and the query will be returned. Not respected for UOWs
   * since those have to be manually executed.
   */
  dryRun?: boolean;
}

/**
 * Creates a Drizzle-based query engine for the given schema.
 *
 * This is the main entry point for creating a database query interface using Drizzle.
 * It uses a compiler-based architecture where queries are compiled to SQL and then executed,
 * enabling features like SQL snapshot testing.
 *
 * @param schema - The database schema definition
 * @param pool - Connection pool for acquiring database connections
 * @param provider - SQL provider (sqlite, mysql, postgresql)
 * @param mapper - Optional table name mapper for namespace prefixing
 * @returns An AbstractQuery instance for performing database operations
 *
 * @example
 * ```ts
 * const pool = createSimpleConnectionPool(drizzle);
 * const queryEngine = fromDrizzle(mySchema, pool, 'postgresql');
 *
 * const uow = queryEngine.createUnitOfWork('myOperation');
 * ```
 */
export function fromDrizzle<T extends AnySchema>(
  schema: T,
  pool: ConnectionPool<DBType>,
  provider: "sqlite" | "mysql" | "postgresql",
  mapper?: TableNameMapper,
  uowConfig?: DrizzleUOWConfig,
): AbstractQuery<T, DrizzleUOWConfig> {
  function createUOW(opts: { name?: string; config?: DrizzleUOWConfig }) {
    const uowCompiler = createDrizzleUOWCompiler(schema, pool, provider, mapper);

    const executor: UOWExecutor<DrizzleCompiledQuery, DrizzleResult> = {
      async executeRetrievalPhase(retrievalBatch: DrizzleCompiledQuery[]) {
        // In dryRun mode, skip execution and return empty results
        if (opts.config?.dryRun) {
          return retrievalBatch.map(() => ({
            rows: [],
            affectedRows: 0,
          }));
        }

        const conn = await pool.connect();
        try {
          const db = parseDrizzle(conn.db)[0];
          return await executeDrizzleRetrievalPhase(db, retrievalBatch, provider);
        } finally {
          await conn.release();
        }
      },
      async executeMutationPhase(mutationBatch: CompiledMutation<DrizzleCompiledQuery>[]) {
        // In dryRun mode, skip execution and return success with mock internal IDs
        if (opts.config?.dryRun) {
          return {
            success: true,
            createdInternalIds: mutationBatch.map(() => null),
          };
        }

        const conn = await pool.connect();
        try {
          const db = parseDrizzle(conn.db)[0];
          return await executeDrizzleMutationPhase(db, mutationBatch, provider);
        } finally {
          await conn.release();
        }
      },
    };

    const decoder = createDrizzleUOWDecoder(schema, provider);

    const { onQuery, ...restUowConfig } = opts.config ?? {};

    return new UnitOfWork(schema, uowCompiler, executor, decoder, opts.name, {
      ...restUowConfig,
      onQuery: (query) => {
        // Handle both CompiledQuery and CompiledMutation structures
        // Retrieval operations return DrizzleCompiledQuery directly: { sql, params }
        // Mutation operations return CompiledMutation: { query: DrizzleCompiledQuery, expectedAffectedRows }
        const actualQuery =
          query && typeof query === "object" && "query" in query
            ? (query as CompiledMutation<DrizzleCompiledQuery>).query
            : (query as DrizzleCompiledQuery);

        opts.config?.onQuery?.(actualQuery);
      },
    });
  }

  return {
    find(tableName, builderFn) {
      const uow = createUOW({ config: uowConfig });
      uow.find(tableName, builderFn);
      return uow.executeRetrieve();
    },

    async findFirst(tableName, builderFn) {
      const uow = createUOW({ config: uowConfig });
      if (builderFn) {
        uow.find(tableName, (b) => builderFn(b as never).pageSize(1));
      } else {
        uow.find(tableName, (b) => b.whereIndex("primary").pageSize(1));
      }
      // executeRetrieve runs an array of `find` operation results, which each return an array of rows
      const [result]: unknown[][] = await uow.executeRetrieve();
      return result?.[0] ?? null;
    },

    async create(tableName, values) {
      const uow = createUOW({ config: uowConfig });
      uow.create(tableName as string, values as never);
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create record");
      }

      const createdIds = uow.getCreatedIds();
      const createdId = createdIds[0];
      if (!createdId) {
        throw new Error("Failed to get created ID");
      }
      return createdId;
    },

    async createMany(tableName, valuesArray) {
      const uow = createUOW({ config: uowConfig });
      for (const values of valuesArray) {
        uow.create(tableName as string, values as never);
      }
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create records");
      }

      return uow.getCreatedIds();
    },

    async update(tableName, id, builderFn) {
      const uow = createUOW({ config: uowConfig });
      uow.update(tableName as string, id, builderFn as never);
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to update record (version conflict or record not found)");
      }
    },

    async updateMany(tableName, builderFn) {
      // FIXME: This is not correct

      let whereConfig: { indexName?: string; condition?: unknown } = {};
      let setValues: unknown;

      const specialBuilder = {
        whereIndex(indexName: string, condition?: unknown) {
          whereConfig = { indexName, condition };
          return this;
        },
        set(values: unknown) {
          setValues = values;
          return this;
        },
      };

      builderFn(specialBuilder);

      if (!whereConfig.indexName) {
        throw new Error("whereIndex() must be called in updateMany");
      }
      if (!setValues) {
        throw new Error("set() must be called in updateMany");
      }

      const findUow = createUOW({ config: uowConfig });
      findUow.find(tableName, (b) => {
        if (whereConfig.condition) {
          return b.whereIndex(whereConfig.indexName as never, whereConfig.condition as never);
        }
        return b.whereIndex(whereConfig.indexName as never);
      });
      const findResults = await findUow.executeRetrieve();
      const records = (findResults as unknown as [unknown])[0];

      // @ts-expect-error - Type narrowing doesn't work through unknown cast
      if (!records || records.length === 0) {
        return;
      }

      const updateUow = createUOW({ config: uowConfig });
      for (const record of records as never as Array<{ id: unknown }>) {
        updateUow.update(tableName as string, record.id as string, (b) =>
          b.set(setValues as never),
        );
      }
      const { success } = await updateUow.executeMutations();
      if (!success) {
        throw new Error("Failed to update records (version conflict)");
      }
    },

    async delete(tableName, id, builderFn) {
      const uow = createUOW({ config: uowConfig });
      uow.delete(tableName as string, id, builderFn as never);
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to delete record (version conflict or record not found)");
      }
    },

    async deleteMany(tableName, builderFn) {
      let whereConfig: { indexName?: string; condition?: unknown } = {};

      const specialBuilder = {
        whereIndex(indexName: string, condition?: unknown) {
          whereConfig = { indexName, condition };
          return this;
        },
      };

      builderFn(specialBuilder as never);

      if (!whereConfig.indexName) {
        throw new Error("whereIndex() must be called in deleteMany");
      }

      const findUow = createUOW({ config: uowConfig });
      findUow.find(tableName as string, (b) => {
        if (whereConfig.condition) {
          return b.whereIndex(whereConfig.indexName as never, whereConfig.condition as never);
        }
        return b.whereIndex(whereConfig.indexName as never);
      });
      const findResults2 = await findUow.executeRetrieve();
      const records = (findResults2 as unknown as [unknown])[0];

      // @ts-expect-error - Type narrowing doesn't work through unknown cast
      if (!records || records.length === 0) {
        return;
      }

      const deleteUow = createUOW({ config: uowConfig });
      for (const record of records as never as Array<{ id: unknown }>) {
        deleteUow.delete(tableName as string, record.id as string);
      }
      const { success } = await deleteUow.executeMutations();
      if (!success) {
        throw new Error("Failed to delete records (version conflict)");
      }
    },

    createUnitOfWork(name, nestedUowConfig) {
      return createUOW({
        name,
        config: {
          ...uowConfig,
          ...nestedUowConfig,
        },
      });
    },
  } as AbstractQuery<T, DrizzleUOWConfig>;
}
