import type {
  AnySchema,
  AnyTable,
  FragnoId,
  Index,
  IdColumn,
  AnyColumn,
  Relation,
} from "../schema/create";
import type { Condition, ConditionBuilder } from "./condition-builder";
import type { SelectClause, TableToInsertValues, TableToUpdateValues, SelectResult } from "./query";
import { buildCondition } from "./condition-builder";
import type { CompiledJoin } from "./orm/orm";

/**
 * Extract column names from a single index
 */
export type IndexColumns<TIndex extends Index> = TIndex["columnNames"][number];

/**
 * Extract all indexed column names from a table's indexes
 */
type IndexedColumns<TIndexes extends Record<string, Index>> = TIndexes[keyof TIndexes] extends Index
  ? IndexColumns<TIndexes[keyof TIndexes]>
  : never;

type OmitNever<T> = { [K in keyof T as T[K] extends never ? never : K]: T[K] };

/**
 * Extract the name of the ID column from a table
 * Checks if column has 'id' property set to true (which IdColumn class has)
 */
export type InferIdColumnName<TTable extends AnyTable> = keyof OmitNever<{
  [K in keyof TTable["columns"]]: TTable["columns"][K] extends IdColumn<
    infer _,
    infer __,
    infer ___
  >
    ? K
    : never;
}>;

/**
 * Get the columns for a specific index name.
 * For "primary", returns only the ID column.
 * For named indexes, returns the columns defined in that index.
 */
type ColumnsForIndex<
  TTable extends AnyTable,
  TIndexName extends ValidIndexName<TTable>,
> = TIndexName extends "primary"
  ? Pick<TTable["columns"], InferIdColumnName<TTable>>
  : TIndexName extends keyof TTable["indexes"]
    ? Pick<TTable["columns"], IndexColumns<TTable["indexes"][TIndexName]>>
    : never;

/**
 * ConditionBuilder restricted to indexed columns only.
 * Used throughout Unit of Work to ensure all queries can leverage indexes for optimal performance.
 */
export type IndexedConditionBuilder<TTable extends AnyTable> = ConditionBuilder<
  Pick<TTable["columns"], IndexedColumns<TTable["indexes"]>>
>;

/**
 * ConditionBuilder restricted to columns in a specific index.
 */
type IndexSpecificConditionBuilder<
  TTable extends AnyTable,
  TIndexName extends ValidIndexName<TTable>,
> = ConditionBuilder<ColumnsForIndex<TTable, TIndexName>>;

/**
 * Valid index names for a table, including the static "primary" index
 */
type ValidIndexName<TTable extends AnyTable> = "primary" | (string & keyof TTable["indexes"]);

/**
 * Find options for Unit of Work (internal, used after builder finalization)
 */
type FindOptions<
  TTable extends AnyTable = AnyTable,
  TSelect extends SelectClause<TTable> = SelectClause<TTable>,
> = {
  /**
   * Which index to use for this query (required)
   */
  useIndex: string;
  /**
   * Select clause - which columns to return
   */
  select?: TSelect;
  /**
   * Where clause - filtering restricted to indexed columns only
   */
  where?: (eb: IndexedConditionBuilder<TTable>) => Condition | boolean;
  /**
   * Order by index - specify which index to order by and direction
   */
  orderByIndex?: {
    indexName: string;
    direction: "asc" | "desc";
  };
  /**
   * Cursor for pagination - continue after this cursor
   */
  after?: string;
  /**
   * Cursor for pagination - continue before this cursor
   */
  before?: string;
  /**
   * Number of results per page
   */
  pageSize?: number;
  /**
   * Join operations to include related data
   */
  joins?: CompiledJoin[];
};

/**
 * Unit of Work state machine
 */
export type UOWState = "building-retrieval" | "building-mutation" | "executed";

/**
 * Retrieval operation - read operations in the first phase
 */
export type RetrievalOperation<
  TSchema extends AnySchema,
  TTable extends AnyTable = TSchema["tables"][keyof TSchema["tables"]],
> =
  | {
      type: "find";
      table: TTable;
      indexName: string;
      options: FindOptions<TTable, SelectClause<TTable>>;
    }
  | {
      type: "count";
      table: TTable;
      indexName: string;
      options: Pick<FindOptions<TTable>, "where" | "useIndex">;
    };

/**
 * Mutation operations - write operations in the second phase
 */
export type MutationOperation<
  TSchema extends AnySchema,
  TTable extends AnyTable = TSchema["tables"][keyof TSchema["tables"]],
> =
  | {
      type: "update";
      table: TTable["name"];
      id: FragnoId | string;
      checkVersion: boolean;
      set: TableToUpdateValues<TTable>;
    }
  | {
      type: "create";
      table: TTable["name"];
      values: TableToInsertValues<TTable>;
    }
  | {
      type: "delete";
      table: TTable["name"];
      id: FragnoId | string;
      checkVersion: boolean;
    };

/**
 * Compiled mutation with metadata for execution
 */
export interface CompiledMutation<TOutput> {
  query: TOutput;
  /**
   * Number of rows this operation must affect for the transaction to succeed.
   * If actual affected rows doesn't match, it indicates a version conflict.
   * null means don't check affected rows (e.g., for create operations).
   */
  expectedAffectedRows: number | null;
}

/**
 * Compiler interface for Unit of Work operations
 */
export interface UOWCompiler<TSchema extends AnySchema, TOutput> {
  /**
   * Compile a retrieval operation to the adapter's query format
   */
  compileRetrievalOperation(op: RetrievalOperation<TSchema>): TOutput | null;

  /**
   * Compile a mutation operation to the adapter's query format
   */
  compileMutationOperation(op: MutationOperation<TSchema>): CompiledMutation<TOutput> | null;
}

/**
 * Executor interface for Unit of Work operations
 */
export interface UOWExecutor<TOutput, TRawResult = unknown> {
  /**
   * Execute the retrieval phase - all queries run in a single transaction for snapshot isolation
   */
  executeRetrievalPhase(retrievalBatch: TOutput[]): Promise<TRawResult[]>;

  /**
   * Execute the mutation phase - all queries run in a transaction with version checks
   * Returns success status indicating if mutations completed without conflicts
   */
  executeMutationPhase(mutationBatch: CompiledMutation<TOutput>[]): Promise<{ success: boolean }>;
}

/**
 * Decoder interface for Unit of Work retrieval results
 *
 * Transforms raw database results into application format (e.g., converting raw columns
 * into FragnoId objects with external ID, internal ID, and version).
 */
export interface UOWDecoder<TSchema extends AnySchema, TRawInput = unknown> {
  /**
   * Decode raw database results from the retrieval phase
   *
   * @param rawResults - Array of raw result sets from database queries
   * @param operations - Array of retrieval operations that produced these results
   * @returns Decoded results in application format
   */
  (rawResults: TRawInput[], operations: RetrievalOperation<TSchema>[]): unknown[];
}

/**
 * Builder for find operations in Unit of Work
 */
export class FindBuilder<
  TTable extends AnyTable,
  TSelect extends SelectClause<TTable> = true,
  TJoinOut = {},
> {
  readonly #table: TTable;
  readonly #tableName: string;

  #indexName?: string;
  #whereClause?: (eb: IndexedConditionBuilder<TTable>) => Condition | boolean;
  #orderByIndexClause?: {
    indexName: string;
    direction: "asc" | "desc";
  };
  #afterCursor?: string;
  #beforeCursor?: string;
  #pageSizeValue?: number;
  #selectClause?: TSelect;
  #joinClause?: (jb: IndexedJoinBuilder<TTable, {}>) => IndexedJoinBuilder<TTable, TJoinOut>;
  #countMode = false;

  constructor(tableName: string, table: TTable) {
    this.#tableName = tableName;
    this.#table = table;
  }

  /**
   * Specify which index to use and optionally filter the results
   */
  whereIndex<TIndexName extends ValidIndexName<TTable>>(
    indexName: TIndexName,
    condition?: (eb: IndexSpecificConditionBuilder<TTable, TIndexName>) => Condition | boolean,
  ): this {
    // Validate index exists (primary is always valid)
    if (indexName !== "primary" && !(indexName in this.#table.indexes)) {
      throw new Error(
        `Index "${String(indexName)}" not found on table "${this.#tableName}". ` +
          `Available indexes: primary, ${Object.keys(this.#table.indexes).join(", ")}`,
      );
    }

    this.#indexName = indexName === "primary" ? "_primary" : indexName;
    if (condition) {
      // Safe: IndexSpecificConditionBuilder is a subset of IndexedConditionBuilder.
      // The condition will only reference columns in the specific index, which are also indexed columns.
      this.#whereClause = condition as unknown as (
        eb: IndexedConditionBuilder<TTable>,
      ) => Condition | boolean;
    }
    return this;
  }

  /**
   * Specify columns to select
   * @throws Error if selectCount() has already been called
   */
  select<const TNewSelect extends SelectClause<TTable>>(
    columns: TNewSelect,
  ): FindBuilder<TTable, TNewSelect, TJoinOut> {
    if (this.#countMode) {
      throw new Error(
        `Cannot call select() after selectCount() on table "${this.#tableName}". ` +
          `Use either select() or selectCount(), not both.`,
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).#selectClause = columns;
    return this as unknown as FindBuilder<TTable, TNewSelect, TJoinOut>;
  }

  /**
   * Select count instead of records
   * @throws Error if select() has already been called
   */
  selectCount(): this {
    if (this.#selectClause !== undefined) {
      throw new Error(
        `Cannot call selectCount() after select() on table "${this.#tableName}". ` +
          `Use either select() or selectCount(), not both.`,
      );
    }
    this.#countMode = true;
    return this;
  }

  /**
   * Order results by index in ascending or descending order
   */
  orderByIndex<TIndexName extends ValidIndexName<TTable>>(
    indexName: TIndexName,
    direction: "asc" | "desc",
  ): this {
    // Validate index exists (primary is always valid)
    if (indexName !== "primary" && !(indexName in this.#table.indexes)) {
      throw new Error(
        `Index "${String(indexName)}" not found on table "${this.#tableName}". ` +
          `Available indexes: primary, ${Object.keys(this.#table.indexes).join(", ")}`,
      );
    }

    this.#orderByIndexClause = {
      indexName: indexName === "primary" ? "_primary" : indexName,
      direction,
    };
    return this;
  }

  /**
   * Set cursor to continue pagination after this point (forward pagination)
   */
  after(cursor: string): this {
    this.#afterCursor = cursor;
    return this;
  }

  /**
   * Set cursor to continue pagination before this point (backward pagination)
   */
  before(cursor: string): this {
    this.#beforeCursor = cursor;
    return this;
  }

  /**
   * Set the number of results per page
   */
  pageSize(size: number): this {
    this.#pageSizeValue = size;
    return this;
  }

  /**
   * Add joins to include related data
   * Join where clauses are restricted to indexed columns only
   */
  join<TNewJoinOut>(
    joinFn: (jb: IndexedJoinBuilder<TTable, {}>) => IndexedJoinBuilder<TTable, TNewJoinOut>,
  ): FindBuilder<TTable, TSelect, TNewJoinOut> {
    this.#joinClause = joinFn;
    return this as unknown as FindBuilder<TTable, TSelect, TNewJoinOut>;
  }

  /**
   * @internal
   */
  build():
    | { type: "find"; indexName: string; options: FindOptions<TTable, TSelect> }
    | {
        type: "count";
        indexName: string;
        options: Pick<FindOptions<TTable>, "where" | "useIndex">;
      } {
    if (!this.#indexName) {
      throw new Error(
        `Must specify an index using .whereIndex() before finalizing find operation on table "${this.#tableName}"`,
      );
    }

    // If in count mode, return count operation
    if (this.#countMode) {
      return {
        type: "count",
        indexName: this.#indexName,
        options: {
          useIndex: this.#indexName,
          where: this.#whereClause,
        },
      };
    }

    // Compile joins if provided
    let compiledJoins: CompiledJoin[] | undefined;
    if (this.#joinClause) {
      compiledJoins = buildJoinIndexed(this.#table, this.#joinClause);
    }

    const options: FindOptions<TTable, TSelect> = {
      useIndex: this.#indexName,
      select: this.#selectClause,
      where: this.#whereClause,
      orderByIndex: this.#orderByIndexClause,
      after: this.#afterCursor,
      before: this.#beforeCursor,
      pageSize: this.#pageSizeValue,
      joins: compiledJoins,
    };

    return { type: "find", indexName: this.#indexName, options };
  }
}

/**
 * Builder for update operations in Unit of Work
 */
export class UpdateBuilder<TTable extends AnyTable> {
  readonly #tableName: string;
  readonly #id: FragnoId | string;

  #checkVersion = false;
  #setValues?: TableToUpdateValues<TTable>;

  constructor(tableName: string, id: FragnoId | string) {
    this.#tableName = tableName;
    this.#id = id;
  }

  /**
   * Specify values to update
   */
  set(values: TableToUpdateValues<TTable>): this {
    this.#setValues = values;
    return this;
  }

  /**
   * Enable version checking for optimistic concurrency control
   * @throws Error if the ID is just a string (no version available)
   */
  check(): this {
    if (typeof this.#id === "string") {
      throw new Error(
        `Cannot use check() with a string ID on table "${this.#tableName}". ` +
          `Version checking requires a FragnoId with version information.`,
      );
    }
    this.#checkVersion = true;
    return this;
  }

  /**
   * @internal
   */
  build(): {
    id: FragnoId | string;
    checkVersion: boolean;
    set: TableToUpdateValues<TTable>;
  } {
    if (!this.#setValues) {
      throw new Error(
        `Must specify values using .set() before finalizing update operation on table "${this.#tableName}"`,
      );
    }

    return {
      id: this.#id,
      checkVersion: this.#checkVersion,
      set: this.#setValues,
    };
  }
}

/**
 * Builder for delete operations in Unit of Work
 */
export class DeleteBuilder {
  readonly #tableName: string;
  readonly #id: FragnoId | string;

  #checkVersion = false;

  constructor(tableName: string, id: FragnoId | string) {
    this.#tableName = tableName;
    this.#id = id;
  }

  /**
   * Enable version checking for optimistic concurrency control
   * @throws Error if the ID is just a string (no version available)
   */
  check(): this {
    if (typeof this.#id === "string") {
      throw new Error(
        `Cannot use check() with a string ID on table "${this.#tableName}". ` +
          `Version checking requires a FragnoId with version information.`,
      );
    }
    this.#checkVersion = true;
    return this;
  }

  /**
   * @internal
   */
  build(): { id: FragnoId | string; checkVersion: boolean } {
    return {
      id: this.#id,
      checkVersion: this.#checkVersion,
    };
  }
}

/**
 * Builder for join operations in Unit of Work
 * Similar to FindBuilder but tailored for joins (no cursor pagination, no count mode)
 */
export class JoinFindBuilder<
  TTable extends AnyTable,
  TSelect extends SelectClause<TTable> = true,
  TJoinOut = {},
> {
  readonly #table: TTable;
  readonly #tableName: string;

  #indexName?: string;
  #whereClause?: (eb: IndexedConditionBuilder<TTable>) => Condition | boolean;
  #orderByIndexClause?: {
    indexName: string;
    direction: "asc" | "desc";
  };
  #pageSizeValue?: number;
  #selectClause?: TSelect;
  #joinClause?: (jb: IndexedJoinBuilder<TTable, TJoinOut>) => IndexedJoinBuilder<TTable, TJoinOut>;

  constructor(tableName: string, table: TTable) {
    this.#tableName = tableName;
    this.#table = table;
  }

  /**
   * Specify which index to use and optionally filter the results
   */
  whereIndex<TIndexName extends ValidIndexName<TTable>>(
    indexName: TIndexName,
    condition?: (eb: IndexSpecificConditionBuilder<TTable, TIndexName>) => Condition | boolean,
  ): this {
    // Validate index exists (primary is always valid)
    if (indexName !== "primary" && !(indexName in this.#table.indexes)) {
      throw new Error(
        `Index "${String(indexName)}" not found on table "${this.#tableName}". ` +
          `Available indexes: primary, ${Object.keys(this.#table.indexes).join(", ")}`,
      );
    }

    this.#indexName = indexName === "primary" ? "_primary" : indexName;
    if (condition) {
      // Safe: IndexSpecificConditionBuilder is a subset of IndexedConditionBuilder.
      // The condition will only reference columns in the specific index, which are also indexed columns.
      this.#whereClause = condition as unknown as (
        eb: IndexedConditionBuilder<TTable>,
      ) => Condition | boolean;
    }
    return this;
  }

  /**
   * Specify columns to select
   */
  select<const TNewSelect extends SelectClause<TTable>>(
    columns: TNewSelect,
  ): JoinFindBuilder<TTable, TNewSelect, TJoinOut> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).#selectClause = columns;
    return this as unknown as JoinFindBuilder<TTable, TNewSelect, TJoinOut>;
  }

  /**
   * Order results by index in ascending or descending order
   */
  orderByIndex<TIndexName extends ValidIndexName<TTable>>(
    indexName: TIndexName,
    direction: "asc" | "desc",
  ): this {
    // Validate index exists (primary is always valid)
    if (indexName !== "primary" && !(indexName in this.#table.indexes)) {
      throw new Error(
        `Index "${String(indexName)}" not found on table "${this.#tableName}". ` +
          `Available indexes: primary, ${Object.keys(this.#table.indexes).join(", ")}`,
      );
    }

    this.#orderByIndexClause = {
      indexName: indexName === "primary" ? "_primary" : indexName,
      direction,
    };
    return this;
  }

  /**
   * Set the number of results to return
   */
  pageSize(size: number): this {
    this.#pageSizeValue = size;
    return this;
  }

  /**
   * Add joins to include related data
   * Join where clauses are restricted to indexed columns only
   */
  join<TNewJoinOut>(
    joinFn: (jb: IndexedJoinBuilder<TTable, {}>) => IndexedJoinBuilder<TTable, TNewJoinOut>,
  ): JoinFindBuilder<TTable, TSelect, TJoinOut & TNewJoinOut> {
    this.#joinClause = joinFn;
    return this as unknown as JoinFindBuilder<TTable, TSelect, TJoinOut & TNewJoinOut>;
  }

  /**
   * @internal
   */
  build(): {
    indexName: string | undefined;
    select: TSelect | undefined;
    where: ((eb: IndexedConditionBuilder<TTable>) => Condition | boolean) | undefined;
    orderByIndex:
      | {
          indexName: string;
          direction: "asc" | "desc";
        }
      | undefined;
    pageSize: number | undefined;
    joins: CompiledJoin[] | undefined;
  } {
    // Compile joins if provided
    let compiledJoins: CompiledJoin[] | undefined;
    if (this.#joinClause) {
      compiledJoins = buildJoinIndexed(this.#table, this.#joinClause);
    }

    return {
      indexName: this.#indexName,
      select: this.#selectClause,
      where: this.#whereClause,
      orderByIndex: this.#orderByIndexClause,
      pageSize: this.#pageSizeValue,
      joins: compiledJoins,
    };
  }
}

/**
 * Join builder with indexed-only where clauses for Unit of Work
 * TJoinOut accumulates the types of all joined relations
 */
export type IndexedJoinBuilder<TTable extends AnyTable, TJoinOut> = {
  [K in keyof TTable["relations"]]: TTable["relations"][K] extends Relation<
    infer _Type,
    infer TTargetTable
  >
    ? <TSelect extends SelectClause<TTable["relations"][K]["table"]> = true, TNestedJoinOut = {}>(
        builderFn?: (
          builder: JoinFindBuilder<TTable["relations"][K]["table"]>,
        ) => JoinFindBuilder<TTable["relations"][K]["table"], TSelect, TNestedJoinOut>,
      ) => IndexedJoinBuilder<
        TTable,
        TJoinOut & {
          [P in K]: SelectResult<TTargetTable, TNestedJoinOut, TSelect>;
        }
      >
    : never;
};

/**
 * Build join operations with indexed-only where clauses for Unit of Work
 * This ensures all join conditions can leverage indexes for optimal performance
 */
export function buildJoinIndexed<TTable extends AnyTable, TJoinOut>(
  table: TTable,
  fn: (builder: IndexedJoinBuilder<TTable, {}>) => IndexedJoinBuilder<TTable, TJoinOut>,
): CompiledJoin[] {
  const compiled: CompiledJoin[] = [];
  const builder: Record<string, unknown> = {};

  for (const name in table.relations) {
    const relation = table.relations[name]!;

    builder[name] = (builderFn?: (b: JoinFindBuilder<AnyTable>) => JoinFindBuilder<AnyTable>) => {
      // Create join builder for this relation's table
      const joinBuilder = new JoinFindBuilder(relation.table.ormName, relation.table);
      if (builderFn) {
        builderFn(joinBuilder);
      }
      const config = joinBuilder.build();

      // Build condition with indexed columns only
      let conditions: Condition | undefined;
      if (config.where) {
        const cond = buildCondition(relation.table.columns, config.where);
        if (cond === true) {
          conditions = undefined;
        } else if (cond === false) {
          // If condition evaluates to false, skip this join
          compiled.push({
            relation,
            options: false,
          });
          delete builder[name];
          return builder;
        } else {
          conditions = cond;
        }
      }

      // Build orderBy from orderByIndex if provided
      let orderBy: [AnyColumn, "asc" | "desc"][] | undefined;
      if (config.orderByIndex) {
        const index = relation.table.indexes[config.orderByIndex.indexName];
        if (index) {
          // Use all columns from the index for ordering
          orderBy = index.columns.map(
            (col) => [col, config.orderByIndex!.direction] as [AnyColumn, "asc" | "desc"],
          );
        } else {
          // Fallback to ID column if index not found
          orderBy = [[relation.table.getIdColumn(), config.orderByIndex.direction]];
        }
      }

      compiled.push({
        relation,
        options: {
          select: config.select ?? true,
          where: conditions,
          orderBy,
          join: config.joins,
          limit: config.pageSize,
        },
      });

      delete builder[name];
      return builder;
    };
  }

  fn(builder as IndexedJoinBuilder<TTable, {}>);
  return compiled;
}

export function createUnitOfWork<
  const TSchema extends AnySchema,
  const TRetrievalResults extends unknown[] = [],
  const TRawInput = unknown,
>(
  schema: TSchema,
  compiler: UOWCompiler<TSchema, unknown>,
  executor: UOWExecutor<unknown, TRawInput>,
  decoder: UOWDecoder<TSchema, TRawInput>,
  name?: string,
): UnitOfWork<TSchema, TRetrievalResults, TRawInput> {
  return new UnitOfWork(schema, compiler, executor, decoder, name) as UnitOfWork<
    TSchema,
    TRetrievalResults,
    TRawInput
  >;
}

/**
 * Unit of Work implementation with optimistic concurrency control
 *
 * UOW has two phases:
 * 1. Retrieval phase: Read operations to fetch entities with their versions
 * 2. Mutation phase: Write operations that check versions before committing
 *
 * @example
 * ```ts
 * const uow = queryEngine.createUnitOfWork("update-user-balance");
 *
 * // Retrieval phase
 * uow.find("users", (b) => b.where("primary", (eb) => eb("id", "=", userId)));
 *
 * // Execute retrieval and transition to mutation phase
 * const [users] = await uow.executeRetrieve();
 *
 * // Mutation phase with version check
 * const user = users[0];
 * uow.update("users", user.id, (b) => b.set({ balance: newBalance }).check());
 *
 * // Execute mutations
 * const { success } = await uow.executeMutations();
 * if (!success) {
 *   // Handle version conflict
 * }
 * ```
 */
export class UnitOfWork<
  const TSchema extends AnySchema,
  const TRetrievalResults extends unknown[] = [],
  const TRawInput = unknown,
> {
  #schema: TSchema;
  #name?: string;
  #state: UOWState = "building-retrieval";
  #retrievalOps: RetrievalOperation<TSchema>[] = [];
  #mutationOps: MutationOperation<TSchema>[] = [];
  #compiler: UOWCompiler<TSchema, unknown>;
  #executor: UOWExecutor<unknown, TRawInput>;
  #decoder: UOWDecoder<TSchema, TRawInput>;
  #retrievalResults?: TRetrievalResults;

  constructor(
    schema: TSchema,
    compiler: UOWCompiler<TSchema, unknown>,
    executor: UOWExecutor<unknown, TRawInput>,
    decoder: UOWDecoder<TSchema, TRawInput>,
    name?: string,
  ) {
    this.#schema = schema;
    this.#compiler = compiler;
    this.#executor = executor;
    this.#decoder = decoder;
    this.#name = name;
  }

  get schema(): TSchema {
    return this.#schema;
  }

  get state(): UOWState {
    return this.#state;
  }

  get name(): string | undefined {
    return this.#name;
  }

  /**
   * Execute the retrieval phase and transition to mutation phase
   * Returns all results from find operations
   */
  async executeRetrieve(): Promise<TRetrievalResults> {
    if (this.#retrievalOps.length === 0) {
      return [] as unknown as TRetrievalResults;
    }

    if (this.#state !== "building-retrieval") {
      throw new Error(
        `Cannot execute retrieval from state ${this.#state}. Must be in building-retrieval state.`,
      );
    }

    // Compile retrieval operations
    const retrievalBatch: unknown[] = [];
    for (const op of this.#retrievalOps) {
      const compiled = this.#compiler.compileRetrievalOperation(op);
      if (compiled !== null) {
        retrievalBatch.push(compiled);
      }
    }

    const results = this.#decoder(
      await this.#executor.executeRetrievalPhase(retrievalBatch),
      this.#retrievalOps,
    );

    // Store results and transition to mutation phase
    this.#retrievalResults = results as TRetrievalResults;
    this.#state = "building-mutation";

    return this.#retrievalResults;
  }

  /**
   * Add a find operation using a builder callback (retrieval phase only)
   */
  find<
    TTableName extends keyof TSchema["tables"] & string,
    TSelect extends SelectClause<TSchema["tables"][TTableName]> = true,
    TJoinOut = {},
  >(
    tableName: TTableName,
    builderFn: (
      // We omit "build" because we don't want to expose it to the user
      builder: Omit<FindBuilder<TSchema["tables"][TTableName]>, "build">,
    ) => Omit<FindBuilder<TSchema["tables"][TTableName], TSelect, TJoinOut>, "build">,
  ): UnitOfWork<
    TSchema,
    [...TRetrievalResults, SelectResult<TSchema["tables"][TTableName], TJoinOut, TSelect>[]],
    TRawInput
  > {
    if (this.#state !== "building-retrieval") {
      throw new Error(
        `find() can only be called during retrieval phase. Current state: ${this.#state}`,
      );
    }

    const table = this.#schema.tables[tableName];
    if (!table) {
      throw new Error(`Table ${tableName} not found in schema`);
    }

    // Create builder, pass to callback, then extract configuration
    const builder = new FindBuilder(tableName, table as TSchema["tables"][TTableName]);
    builderFn(builder);
    const { indexName, options, type } = builder.build();

    this.#retrievalOps.push({
      type,
      // Safe: we know the table is part of the schema from the find() method
      table: table as TSchema["tables"][TTableName],
      indexName,
      // Safe: we're storing the options for later compilation
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options: options as any,
    });

    return this as unknown as UnitOfWork<
      TSchema,
      [...TRetrievalResults, SelectResult<TSchema["tables"][TTableName], TJoinOut, TSelect>[]],
      TRawInput
    >;
  }

  /**
   * Add a create operation (mutation phase only)
   */
  create<TableName extends keyof TSchema["tables"] & string>(
    table: TableName,
    values: TableToInsertValues<TSchema["tables"][TableName]>,
  ): this {
    if (this.#state === "executed") {
      throw new Error(`create() can only be called during mutation phase.`);
    }

    this.#mutationOps.push({
      type: "create",
      table,
      values,
    });

    return this;
  }

  /**
   * Add an update operation using a builder callback (mutation phase only)
   */
  update<TableName extends keyof TSchema["tables"] & string>(
    table: TableName,
    id: FragnoId | string,
    builderFn: (
      // We omit "build" because we don't want to expose it to the user
      builder: Omit<UpdateBuilder<TSchema["tables"][TableName]>, "build">,
    ) => Omit<UpdateBuilder<TSchema["tables"][TableName]>, "build">,
  ): this {
    if (this.#state === "executed") {
      throw new Error(`update() can only be called during mutation phase.`);
    }

    // Create builder, pass to callback, then extract configuration
    const builder = new UpdateBuilder<TSchema["tables"][TableName]>(table, id);
    builderFn(builder);
    const { id: opId, checkVersion, set } = builder.build();

    this.#mutationOps.push({
      type: "update",
      table,
      id: opId,
      checkVersion,
      set,
    });

    return this;
  }

  /**
   * Add a delete operation using a builder callback (mutation phase only)
   */
  delete<TableName extends keyof TSchema["tables"] & string>(
    table: TableName,
    id: FragnoId | string,
    builderFn?: (
      // We omit "build" because we don't want to expose it to the user
      builder: Omit<DeleteBuilder, "build">,
    ) => Omit<DeleteBuilder, "build">,
  ): this {
    if (this.#state === "executed") {
      throw new Error(`delete() can only be called during mutation phase.`);
    }

    // Create builder, optionally pass to callback, then extract configuration
    const builder = new DeleteBuilder(table, id);
    builderFn?.(builder);
    const { id: opId, checkVersion } = builder.build();

    this.#mutationOps.push({
      type: "delete",
      table,
      id: opId,
      checkVersion,
    });

    return this;
  }

  /**
   * Execute the mutation phase
   * Returns success flag indicating if mutations completed without conflicts
   */
  async executeMutations(): Promise<{ success: boolean }> {
    if (this.#state === "executed") {
      throw new Error(`Cannot execute mutations from state ${this.#state}.`);
    }

    // Compile mutation operations
    const mutationBatch: CompiledMutation<unknown>[] = [];
    for (const op of this.#mutationOps) {
      const compiled = this.#compiler.compileMutationOperation(op);
      if (compiled !== null) {
        mutationBatch.push(compiled);
      }
    }

    // Execute mutation phase
    const result = await this.#executor.executeMutationPhase(mutationBatch);

    // Transition to executed state
    this.#state = "executed";

    return result;
  }

  /**
   * Get the retrieval operations (for inspection/debugging)
   */
  getRetrievalOperations(): ReadonlyArray<RetrievalOperation<TSchema>> {
    return this.#retrievalOps;
  }

  /**
   * Get the mutation operations (for inspection/debugging)
   */
  getMutationOperations(): ReadonlyArray<MutationOperation<TSchema>> {
    return this.#mutationOps;
  }

  /**
   * @internal
   * Compile the unit of work to executable queries for testing
   */
  compile<TOutput>(compiler: UOWCompiler<TSchema, TOutput>): {
    name?: string;
    retrievalBatch: TOutput[];
    mutationBatch: CompiledMutation<TOutput>[];
  } {
    const retrievalBatch: TOutput[] = [];
    for (const op of this.#retrievalOps) {
      const compiled = compiler.compileRetrievalOperation(op);
      if (compiled !== null) {
        retrievalBatch.push(compiled);
      }
    }

    const mutationBatch: CompiledMutation<TOutput>[] = [];
    for (const op of this.#mutationOps) {
      const compiled = compiler.compileMutationOperation(op);
      if (compiled !== null) {
        mutationBatch.push(compiled);
      }
    }

    return {
      name: this.#name,
      retrievalBatch,
      mutationBatch,
    };
  }
}
