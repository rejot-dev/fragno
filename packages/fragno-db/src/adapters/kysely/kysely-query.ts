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
import { createCursorFromRecord, Cursor, type CursorResult } from "../../query/cursor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KyselyAny = Kysely<any>;

/**
 * Configuration options for creating a Kysely Unit of Work
 */
export interface KyselyUOWConfig {
  /**
   * Optional callback to receive compiled SQL queries for logging/debugging
   * This callback is invoked for each query as it's compiled
   */
  onQuery?: (query: CompiledQuery) => void;
  /**
   * If true, the query will not be executed and the query will be returned. Not respected for UOWs
   * since those have to be manually executed.
   */
  dryRun?: boolean;
}

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
 * @param uowConfig - Optional UOW configuration
 * @param schemaNamespaceMap - Optional WeakMap for schema-to-namespace lookups
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
  uowConfig?: KyselyUOWConfig,
  schemaNamespaceMap?: WeakMap<AnySchema, string>,
): AbstractQuery<T, KyselyUOWConfig> {
  function createUOW(opts: { name?: string; config?: KyselyUOWConfig }) {
    const uowCompiler = createKyselyUOWCompiler(pool, provider, mapper);

    const executor: UOWExecutor<CompiledQuery, unknown> = {
      async executeRetrievalPhase(retrievalBatch: CompiledQuery[]) {
        // In dryRun mode, skip execution and return empty results
        if (opts.config?.dryRun) {
          return retrievalBatch.map(() => []);
        }

        const conn = await pool.connect();
        try {
          return await executeKyselyRetrievalPhase(conn.db, retrievalBatch);
        } finally {
          await conn.release();
        }
      },
      async executeMutationPhase(mutationBatch: CompiledMutation<CompiledQuery>[]) {
        // In dryRun mode, skip execution and return success with mock internal IDs
        if (opts.config?.dryRun) {
          return {
            success: true,
            createdInternalIds: mutationBatch.map(() => null),
          };
        }

        const conn = await pool.connect();
        try {
          return await executeKyselyMutationPhase(conn.db, mutationBatch);
        } finally {
          await conn.release();
        }
      },
    };

    // Create a decoder function to transform raw results into application format
    const decoder: UOWDecoder<unknown> = (rawResults, ops) => {
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
        const decodedRows = rowArray.map((row) => decodeResult(row, op.table, provider));

        // If cursor generation is requested, wrap in CursorResult
        if (op.withCursor) {
          let cursor: Cursor | undefined;
          let hasNextPage = false;
          let items = decodedRows;

          // Check if there are more results (we fetched pageSize + 1)
          if (op.options.pageSize && decodedRows.length > op.options.pageSize) {
            hasNextPage = true;
            // Trim to requested pageSize
            items = decodedRows.slice(0, op.options.pageSize);

            // Generate cursor from the last item we're returning
            if (op.options.orderByIndex) {
              const lastItem = items[items.length - 1];
              const indexName = op.options.orderByIndex.indexName;

              // Get index columns
              let indexColumns;
              if (indexName === "_primary") {
                indexColumns = [op.table.getIdColumn()];
              } else {
                const index = op.table.indexes[indexName];
                if (index) {
                  indexColumns = index.columns;
                }
              }

              if (indexColumns && lastItem) {
                cursor = createCursorFromRecord(lastItem as Record<string, unknown>, indexColumns, {
                  indexName: op.options.orderByIndex.indexName,
                  orderDirection: op.options.orderByIndex.direction,
                  pageSize: op.options.pageSize,
                });
              }
            }
          }

          const result: CursorResult<unknown> = {
            items,
            cursor,
            hasNextPage,
          };
          return result;
        }

        return decodedRows;
      });
    };

    const { onQuery, ...restUowConfig } = opts.config ?? {};

    return new UnitOfWork(
      schema,
      uowCompiler,
      executor,
      decoder,
      opts.name,
      {
        ...restUowConfig,
        onQuery: (query) => {
          // CompiledMutation has { query: CompiledQuery, expectedAffectedRows: number | null }
          // CompiledQuery has { query: QueryAST, sql: string, parameters: unknown[] }
          // Check for expectedAffectedRows to distinguish CompiledMutation from CompiledQuery
          const actualQuery =
            query && typeof query === "object" && "expectedAffectedRows" in query
              ? (query as CompiledMutation<CompiledQuery>).query
              : (query as CompiledQuery);

          opts.config?.onQuery?.(actualQuery);
        },
      },
      schemaNamespaceMap,
    );
  }

  return {
    async find(tableName, builderFn) {
      const uow = createUOW({ config: uowConfig });
      // Safe: builderFn returns a FindBuilder (or void), which matches UnitOfWork signature
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      uow.find(tableName, builderFn as any);
      // executeRetrieve returns an array of results (one per find operation)
      // Since we only have one find, unwrap the first result
      const [result]: unknown[][] = await uow.executeRetrieve();
      return result ?? [];
    },

    async findWithCursor(tableName, builderFn) {
      // Safe: builderFn returns a FindBuilder, which matches UnitOfWork signature
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const uow = createUOW({ config: uowConfig }).findWithCursor(tableName, builderFn as any);
      // executeRetrieve returns an array of results (one per find operation)
      // Since we only have one findWithCursor, unwrap the first result
      const [result] = await uow.executeRetrieve();
      return result as CursorResult<unknown>;
    },

    async findFirst(tableName, builderFn) {
      const uow = createUOW({ config: uowConfig });
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
      const uow = createUOW({ config: uowConfig });
      uow.create(tableName, values);
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
        uow.create(tableName, values);
      }
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create records");
      }

      return uow.getCreatedIds();
    },

    async update(tableName, id, builderFn) {
      const uow = createUOW({ config: uowConfig });
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

      const findUow = createUOW({ config: uowConfig });
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

      const updateUow = createUOW({ config: uowConfig });
      for (const record of records as Array<{ id: unknown }>) {
        updateUow.update(tableName, record.id as string, (b) => b.set(setValues));
      }
      const { success } = await updateUow.executeMutations();
      if (!success) {
        throw new Error("Failed to update records (version conflict)");
      }
    },

    async delete(tableName, id, builderFn) {
      const uow = createUOW({ config: uowConfig });
      uow.delete(tableName, id, builderFn);
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to delete record (version conflict or record not found)");
      }
    },

    async deleteMany(tableName, builderFn) {
      const findUow = createUOW({ config: uowConfig });
      findUow.find(tableName, builderFn);
      const [records]: unknown[][] = await findUow.executeRetrieve();

      if (!records || records.length === 0) {
        return;
      }

      const deleteUow = createUOW({ config: uowConfig });
      for (const record of records as Array<{ id: unknown }>) {
        deleteUow.delete(tableName, record.id as string);
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
  } as AbstractQuery<T, KyselyUOWConfig>;
}
