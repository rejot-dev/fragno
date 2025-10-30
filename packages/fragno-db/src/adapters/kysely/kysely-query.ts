import type { AbstractQuery, TableToUpdateValues } from "../../query/query";
import type { AnySchema, AnyTable } from "../../schema/create";
import type {
  CompiledMutation,
  UOWDecoder,
  UOWExecutor,
  ValidIndexName,
} from "../../query/unit-of-work";
import { decodeResult } from "../../query/result-transform";
import { createKyselyUOWCompiler } from "./kysely-uow-compiler";
import { executeKyselyRetrievalPhase, executeKyselyMutationPhase } from "./kysely-uow-executor";
import { UnitOfWork } from "../../query/unit-of-work";
import type { CompiledQuery, Kysely } from "kysely";
import type { TableNameMapper } from "./kysely-shared";
import type { ConnectionPool } from "../../shared/connection-pool";
import type { SQLProvider } from "../../shared/providers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KyselyAny = Kysely<any>;

/**
 * Special builder for updateMany operations that captures configuration
 */
class UpdateManySpecialBuilder<TTable extends AnyTable> {
  #indexName?: string;
  #condition?: unknown;
  #setValues?: TableToUpdateValues<TTable>;

  whereIndex<TIndexName extends ValidIndexName<TTable>>(
    indexName: TIndexName,
    condition?: unknown,
  ): this {
    this.#indexName = indexName as string;
    this.#condition = condition;
    return this;
  }

  set(values: TableToUpdateValues<TTable>): this {
    this.#setValues = values;
    return this;
  }

  getConfig() {
    return {
      indexName: this.#indexName,
      condition: this.#condition,
      setValues: this.#setValues,
    };
  }
}

/**
 * Creates a Kysely-based query engine for the given schema.
 *
 * This is the main entry point for creating a database query interface using Kysely.
 * It uses a compiler-based architecture where queries are compiled to SQL and then executed,
 * enabling features like SQL snapshot testing.
 *
 * @param schema - The database schema definition
 * @param pool - Connection pool for acquiring database connections
 * @param provider - SQL provider (postgresql, mysql, sqlite, etc.)
 * @param mapper - Optional table name mapper for namespace prefixing
 * @returns An AbstractQuery instance for performing database operations
 *
 * @example
 * ```ts
 * const pool = createSimpleConnectionPool(kysely);
 * const queryEngine = fromKysely(mySchema, pool, 'postgresql');
 *
 * const users = await queryEngine.findMany('users', {
 *   where: (b) => b('age', '>', 18),
 *   orderBy: [['name', 'asc']]
 * });
 * ```
 */
export function fromKysely<T extends AnySchema>(
  schema: T,
  pool: ConnectionPool<KyselyAny>,
  provider: SQLProvider,
  mapper?: TableNameMapper,
): AbstractQuery<T> {
  function createUOW(name?: string): UnitOfWork<T, []> {
    const uowCompiler = createKyselyUOWCompiler(schema, pool, provider, mapper);

    const executor: UOWExecutor<CompiledQuery, unknown> = {
      async executeRetrievalPhase(retrievalBatch: CompiledQuery[]) {
        const conn = await pool.connect();
        try {
          return await executeKyselyRetrievalPhase(conn.db, retrievalBatch);
        } finally {
          await conn.release();
        }
      },
      async executeMutationPhase(mutationBatch: CompiledMutation<CompiledQuery>[]) {
        const conn = await pool.connect();
        try {
          return await executeKyselyMutationPhase(conn.db, mutationBatch);
        } finally {
          await conn.release();
        }
      },
    };

    // Create a decoder function to transform raw results into application format
    const decoder: UOWDecoder<T> = (rawResults, ops) => {
      if (rawResults.length !== ops.length) {
        throw new Error("rawResults and ops must have the same length");
      }

      return rawResults.map((rows, index) => {
        const op = ops[index];
        if (!op) {
          throw new Error("op must be defined");
        }

        // Handle count operations differently - return the count number directly
        if (op.type === "count") {
          const rowArray = rows as Record<string, unknown>[];
          const firstRow = rowArray[0];
          if (!firstRow) {
            return 0;
          }
          const count = Number(firstRow["count"]);
          if (Number.isNaN(count)) {
            throw new Error(`Unexpected result for count, received: ${count}`);
          }
          return count;
        }

        // Each result is an array of rows - decode each row
        const rowArray = rows as Record<string, unknown>[];
        return rowArray.map((row) => decodeResult(row, op.table, provider));
      });
    };

    return new UnitOfWork(schema, uowCompiler, executor, decoder, name);
  }

  return {
    async find(tableName, builderFn) {
      const uow = createUOW();
      // Safe: builderFn returns a FindBuilder (or void), which matches UnitOfWork signature
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      uow.find(tableName, builderFn as any);
      // executeRetrieve returns an array of results (one per find operation)
      // Since we only have one find, unwrap the first result
      const [result]: unknown[][] = await uow.executeRetrieve();
      return result ?? [];
    },

    async findFirst(tableName, builderFn) {
      const uow = createUOW();
      if (builderFn) {
        uow.find(tableName, (b) => {
          builderFn(b);
          return b.pageSize(1);
        });
      } else {
        uow.find(tableName, (b) => b.whereIndex("primary").pageSize(1));
      }
      // executeRetrieve runs an array of `find` operation results, which each return an array of rows
      const [result]: unknown[][] = await uow.executeRetrieve();
      return result?.[0] ?? null;
    },

    async create(tableName, values) {
      const uow = createUOW();
      uow.create(tableName, values);
      const { success } = await uow.executeMutations();
      if (!success) {
        // This should not happen because we don't `.check()` this call.
        // TODO: Verify what happens when there are unique constraints
        throw new Error("Failed to create record");
      }

      const [createdId] = uow.getCreatedIds();
      if (!createdId) {
        throw new Error("Failed to get created ID");
      }
      return createdId;
    },

    async createMany(tableName, valuesArray) {
      const uow = createUOW();
      for (const values of valuesArray) {
        uow.create(tableName, values);
      }
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create records");
      }

      return uow.getCreatedIds();
    },

    async update(tableName, id, builderFn) {
      const uow = createUOW();
      uow.update(tableName, id, builderFn);
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to update record (version conflict or record not found)");
      }
    },

    async updateMany(tableName, builderFn) {
      const table = schema.tables[tableName];
      if (!table) {
        throw new Error(`Table ${tableName} not found in schema`);
      }

      const specialBuilder = new UpdateManySpecialBuilder<typeof table>();
      builderFn(specialBuilder);

      const { indexName, condition, setValues } = specialBuilder.getConfig();

      if (!indexName) {
        throw new Error("whereIndex() must be called in updateMany");
      }
      if (!setValues) {
        throw new Error("set() must be called in updateMany");
      }

      // First, find all matching records
      const findUow = createUOW();
      findUow.find(tableName, (b) => {
        if (condition) {
          // Safe: condition is captured from whereIndex call with proper typing
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return b.whereIndex(indexName as ValidIndexName<typeof table>, condition as any);
        }
        return b.whereIndex(indexName as ValidIndexName<typeof table>);
      });
      const [records]: unknown[][] = await findUow.executeRetrieve();

      if (!records || records.length === 0) {
        return;
      }

      // Now update all found records
      const updateUow = createUOW();
      for (const record of records as Array<{ id: unknown }>) {
        updateUow.update(tableName, record.id as string, (b) => b.set(setValues));
      }
      const { success } = await updateUow.executeMutations();
      if (!success) {
        throw new Error("Failed to update records (version conflict)");
      }
    },

    async delete(tableName, id, builderFn) {
      const uow = createUOW();
      uow.delete(tableName, id, builderFn);
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to delete record (version conflict or record not found)");
      }
    },

    async deleteMany(tableName, builderFn) {
      const findUow = createUOW();
      findUow.find(tableName, builderFn);
      const [records]: unknown[][] = await findUow.executeRetrieve();

      if (!records || records.length === 0) {
        return;
      }

      // Now delete all found records
      const deleteUow = createUOW();
      for (const record of records as Array<{ id: unknown }>) {
        deleteUow.delete(tableName, record.id as string);
      }
      const { success } = await deleteUow.executeMutations();
      if (!success) {
        throw new Error("Failed to delete records (version conflict)");
      }
    },

    createUnitOfWork(name) {
      return createUOW(name);
    },
  } as AbstractQuery<T>;
}
