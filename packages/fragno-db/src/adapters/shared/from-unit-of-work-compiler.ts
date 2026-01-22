import type { SimpleQueryInterface, TableToUpdateValues } from "../../query/simple-query-interface";
import type { AnySchema, AnyTable, FragnoId } from "../../schema/create";
import type {
  CompiledMutation,
  UOWCompiler,
  UOWDecoder,
  UOWExecutor,
  UOWInstrumentation,
  ValidIndexName,
} from "../../query/unit-of-work/unit-of-work";
import { UnitOfWork } from "../../query/unit-of-work/unit-of-work";
import type { CursorResult } from "../../query/cursor";
import type { CompiledQuery } from "../../sql-driver/sql-driver";

/**
 * Configuration options for creating a Unit of Work with generic SQL
 */
export interface UnitOfWorkConfig {
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
  instrumentation?: UOWInstrumentation;
}

/**
 * Factory interface for creating Unit of Work instances
 */
export interface UnitOfWorkFactory {
  /**
   * UOW compiler for compiling operations to SQL
   */
  compiler: UOWCompiler<CompiledQuery>;
  /**
   * UOW executor for running compiled queries
   */
  executor: UOWExecutor<CompiledQuery, unknown>;
  /**
   * UOW decoder for transforming raw results
   */
  decoder: UOWDecoder<unknown>;
  /**
   * Optional UOW configuration
   */
  uowConfig?: UnitOfWorkConfig;
  /**
   * Optional WeakMap for schema-to-namespace lookups
   */
  schemaNamespaceMap?: WeakMap<AnySchema, string>;
}

/**
 * Type guard to check if a query is a CompiledMutation
 */
function isCompiledMutation(query: unknown): query is CompiledMutation<CompiledQuery> {
  return (
    query !== null &&
    typeof query === "object" &&
    "expectedAffectedRows" in query &&
    "query" in query
  );
}

/**
 * Type guard to check if a record has an id field
 */
function hasIdField(record: unknown): record is { id: string | FragnoId } {
  return record !== null && typeof record === "object" && "id" in record;
}

class UpdateManySpecialBuilder<TTable extends AnyTable> {
  #indexName?: ValidIndexName<TTable>;
  #condition?: unknown;
  #setValues?: TableToUpdateValues<TTable>;

  whereIndex<TIndexName extends ValidIndexName<TTable>>(
    indexName: TIndexName,
    condition?: unknown,
  ): this {
    this.#indexName = indexName;
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
 * Creates a generic SQL-based query engine for the given schema using a UnitOfWorkFactory.
 *
 * This is the main entry point for creating a database query interface using a Unit of Work compiler.
 * It uses a compiler-based architecture where queries are compiled to SQL and then executed,
 * enabling features like SQL snapshot testing.
 *
 * @param schema - The database schema definition
 * @param factory - Factory containing compiler, executor, decoder, and optional configuration
 * @returns An SimpleQueryInterface instance for performing database operations
 *
 * @example
 * ```ts
 * const operationCompiler = new GenericSQLUOWOperationCompiler(driverConfig);
 * const factory: UnitOfWorkFactory = {
 *   compiler: createUOWCompilerFromOperationCompiler(operationCompiler),
 *   executor: createExecutor(sqlDriver),
 *   decoder: createKyselyUOWDecoder(driverConfig.databaseType),
 * };
 * const queryEngine = fromUnitOfWorkCompiler(mySchema, factory);
 *
 * const users = await queryEngine.find('users', (b) =>
 *   b.whereIndex('age').where((eb) => eb('age', '>', 18))
 * );
 * ```
 */
export function fromUnitOfWorkCompiler<T extends AnySchema>(
  schema: T,
  factory: UnitOfWorkFactory,
): SimpleQueryInterface<T, UnitOfWorkConfig> {
  const { compiler, executor, decoder, uowConfig, schemaNamespaceMap } = factory;

  function createUOW(opts: { name?: string; config?: UnitOfWorkConfig }) {
    const { onQuery, ...restUowConfig } = opts.config ?? {};

    return new UnitOfWork(
      compiler,
      executor,
      decoder,
      opts.name,
      {
        ...restUowConfig,
        onQuery: onQuery
          ? (query) => {
              // Extract the actual query from CompiledMutation if needed
              const actualQuery = isCompiledMutation(query)
                ? query.query
                : (query as CompiledQuery);
              onQuery(actualQuery);
            }
          : undefined,
      },
      schemaNamespaceMap,
    ).forSchema(schema);
  }

  return {
    async find(tableName, builderFn) {
      const uow = createUOW({ config: uowConfig });
      uow.find(tableName, builderFn);
      const [result]: unknown[][] = await uow.executeRetrieve();
      return result ?? [];
    },

    async findWithCursor(tableName, builderFn) {
      const uow = createUOW({ config: uowConfig }).findWithCursor(tableName, builderFn);
      const [result] = await uow.executeRetrieve();
      // Result from findWithCursor is always a CursorResult - the UOW decoder handles the conversion
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
        // Condition might be null or undefined, only pass if defined and not null
        if (condition !== undefined && condition !== null) {
          // TypeScript can't infer the complex condition type from the builder
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return b.whereIndex(indexName, condition as any);
        }
        return b.whereIndex(indexName);
      });
      const [records]: unknown[][] = await findUow.executeRetrieve();

      if (!records || records.length === 0) {
        return;
      }

      const updateUow = createUOW({ config: uowConfig });
      for (const record of records) {
        if (!hasIdField(record)) {
          throw new Error("Record missing id field");
        }
        updateUow.update(tableName, record.id, (b) => b.set(setValues));
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
      for (const record of records) {
        if (!hasIdField(record)) {
          throw new Error("Record missing id field");
        }
        deleteUow.delete(tableName, record.id);
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
  } as SimpleQueryInterface<T, UnitOfWorkConfig>;
}
