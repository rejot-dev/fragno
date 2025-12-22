import type {
  AnySchema,
  AnyTable,
  Index,
  IdColumn,
  AnyColumn,
  Relation,
} from "../../schema/create";
import { FragnoId } from "../../schema/create";
import type { Condition, ConditionBuilder } from "../condition-builder";
import type {
  SelectClause,
  TableToInsertValues,
  TableToUpdateValues,
  SelectResult,
  ExtractSelect,
  ExtractJoinOut,
} from "../simple-query-interface";
import { buildCondition } from "../condition-builder";
import type { CompiledJoin } from "../orm/orm";
import type { CursorResult } from "../cursor";
import { Cursor } from "../cursor";
import type { Prettify } from "../../util/types";
import type { TriggeredHook, TriggerHookOptions, HooksMap, HookPayload } from "../../hooks/hooks";

/**
 * Builder for updateMany operations that supports both whereIndex and set chaining
 */
export interface UpdateManyBuilder<TTable extends AnyTable> {
  whereIndex<TIndexName extends ValidIndexName<TTable>>(
    indexName: TIndexName,
    condition?: (eb: IndexSpecificConditionBuilder<TTable, TIndexName>) => Condition | boolean,
  ): this;
  set(values: TableToUpdateValues<TTable>): this;
}

/**
 * Extract column names from a single index
 */
export type IndexColumns<TIndex extends Index> = TIndex["columnNames"][number];

type RemoveEmptyObject<T> = T extends object ? (keyof T extends never ? never : T) : never;

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
export type ValidIndexName<TTable extends AnyTable> =
  | "primary"
  | (string & keyof TTable["indexes"]);

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
  after?: Cursor | string;
  /**
   * Cursor for pagination - continue before this cursor
   */
  before?: Cursor | string;
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
      schema: TSchema;
      namespace?: string;
      table: TTable;
      indexName: string;
      options: FindOptions<TTable, SelectClause<TTable>>;
      withCursor?: boolean;
      withSingleResult?: boolean;
    }
  | {
      type: "count";
      schema: TSchema;
      namespace?: string;
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
      schema: TSchema;
      namespace?: string;
      table: TTable["name"];
      id: FragnoId | string;
      checkVersion: boolean;
      set: TableToUpdateValues<TTable>;
    }
  | {
      type: "create";
      schema: TSchema;
      namespace?: string;
      table: TTable["name"];
      values: TableToInsertValues<TTable>;
      generatedExternalId: string;
    }
  | {
      type: "delete";
      schema: TSchema;
      namespace?: string;
      table: TTable["name"];
      id: FragnoId | string;
      checkVersion: boolean;
    }
  | {
      type: "check";
      schema: TSchema;
      namespace?: string;
      table: TTable["name"];
      id: FragnoId;
    };

/**
 * Compiled mutation with metadata for execution
 */
export interface CompiledMutation<TOutput> {
  query: TOutput;
  /**
   * The type of mutation operation (create, update, delete, or check).
   */
  op: "create" | "update" | "delete" | "check";
  /**
   * Number of rows this operation must affect for the transaction to succeed.
   * If actual affected rows doesn't match, it indicates a version conflict.
   * null means don't check affected rows (e.g., for create operations).
   */
  expectedAffectedRows: bigint | null;
  /**
   * Number of rows this SELECT query must return for the transaction to succeed.
   * Used for check operations to verify version without modifying data.
   * null means this is not a SELECT query that needs row count validation.
   */
  expectedReturnedRows: number | null;
}

/**
 * Compiler interface for Unit of Work operations
 */
export interface UOWCompiler<TOutput> {
  /**
   * Compile a retrieval operation to the adapter's query format
   */
  compileRetrievalOperation(op: RetrievalOperation<AnySchema>): TOutput | null;

  /**
   * Compile a mutation operation to the adapter's query format
   */
  compileMutationOperation(op: MutationOperation<AnySchema>): CompiledMutation<TOutput> | null;
}

export type MutationResult =
  | { success: true; createdInternalIds: (bigint | null)[] }
  | { success: false };

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
   * Returns success status indicating if mutations completed without conflicts,
   * and internal IDs for create operations (null if database doesn't support RETURNING)
   */
  executeMutationPhase(mutationBatch: CompiledMutation<TOutput>[]): Promise<MutationResult>;
}

/**
 * Decoder interface for Unit of Work retrieval results
 *
 * Transforms raw database results into application format (e.g., converting raw columns
 * into FragnoId objects with external ID, internal ID, and version).
 */
export interface UOWDecoder<TRawInput = unknown> {
  /**
   * Decode raw database results from the retrieval phase
   *
   * @param rawResults - Array of raw result sets from database queries
   * @param operations - Array of retrieval operations that produced these results
   * @returns Decoded results in application format
   */
  decode(rawResults: TRawInput[], operations: RetrievalOperation<AnySchema>[]): unknown[];
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
  #afterCursor?: Cursor | string;
  #beforeCursor?: Cursor | string;
  #pageSizeValue?: number;
  #selectClause?: TSelect;
  #joinClause?: (jb: IndexedJoinBuilder<TTable, {}>) => IndexedJoinBuilder<TTable, TJoinOut>;
  #countMode = false;
  #cursorMetadata?: Cursor;

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
   * If a Cursor object is provided, its metadata will be used to set defaults for
   * index, orderByIndex, and pageSize (if not explicitly set)
   */
  after(cursor: Cursor | string): this {
    this.#afterCursor = cursor;
    if (cursor instanceof Cursor) {
      this.#cursorMetadata = cursor;
    }
    return this;
  }

  /**
   * Set cursor to continue pagination before this point (backward pagination)
   * If a Cursor object is provided, its metadata will be used to set defaults for
   * index, orderByIndex, and pageSize (if not explicitly set)
   */
  before(cursor: Cursor | string): this {
    this.#beforeCursor = cursor;
    if (cursor instanceof Cursor) {
      this.#cursorMetadata = cursor;
    }
    return this;
  }

  /**
   * Set the number of results per page
   * @throws {RangeError} If size is not a positive integer
   */
  pageSize(size: number): this {
    if (!Number.isInteger(size) || size <= 0) {
      throw new RangeError(`pageSize must be a positive integer, received: ${size}`);
    }
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
    // Apply cursor metadata as defaults if available and not explicitly set
    let indexName = this.#indexName;
    let orderByIndex = this.#orderByIndexClause;
    let pageSize = this.#pageSizeValue;

    if (this.#cursorMetadata) {
      // Use cursor metadata as defaults
      if (!indexName) {
        indexName = this.#cursorMetadata.indexName;
      }
      if (!orderByIndex) {
        orderByIndex = {
          indexName: this.#cursorMetadata.indexName,
          direction: this.#cursorMetadata.orderDirection,
        };
      }
      if (pageSize === undefined) {
        pageSize = this.#cursorMetadata.pageSize;
      }

      // Validate that explicit params match cursor params
      if (indexName && indexName !== this.#cursorMetadata.indexName) {
        throw new Error(
          `Index mismatch: builder specifies "${indexName}" but cursor specifies "${this.#cursorMetadata.indexName}"`,
        );
      }
      if (
        orderByIndex &&
        (orderByIndex.indexName !== this.#cursorMetadata.indexName ||
          orderByIndex.direction !== this.#cursorMetadata.orderDirection)
      ) {
        throw new Error(`Order mismatch: builder and cursor specify different ordering`);
      }
      if (pageSize !== undefined && pageSize !== this.#cursorMetadata.pageSize) {
        throw new Error(
          `Page size mismatch: builder specifies ${pageSize} but cursor specifies ${this.#cursorMetadata.pageSize}`,
        );
      }
    }

    if (!indexName) {
      throw new Error(
        `Must specify an index using .whereIndex() before finalizing find operation on table "${this.#tableName}"`,
      );
    }

    // If in count mode, return count operation
    if (this.#countMode) {
      return {
        type: "count",
        indexName,
        options: {
          useIndex: indexName,
          where: this.#whereClause,
        },
      };
    }

    // Compile joins if provided
    let compiledJoins: CompiledJoin[] | undefined;
    if (this.#joinClause) {
      compiledJoins = buildJoinIndexed(this.#table, this.#joinClause);
    }

    // Convert Cursor objects to strings for after/before
    const afterCursor =
      this.#afterCursor instanceof Cursor ? this.#afterCursor.encode() : this.#afterCursor;
    const beforeCursor =
      this.#beforeCursor instanceof Cursor ? this.#beforeCursor.encode() : this.#beforeCursor;

    const options: FindOptions<TTable, TSelect> = {
      useIndex: indexName,
      select: this.#selectClause,
      where: this.#whereClause,
      orderByIndex,
      after: afterCursor,
      before: beforeCursor,
      pageSize,
      joins: compiledJoins,
    };

    return { type: "find", indexName, options };
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
   * @throws {RangeError} If size is not a positive integer
   */
  pageSize(size: number): this {
    if (!Number.isInteger(size) || size <= 0) {
      throw new RangeError(`pageSize must be a positive integer, received: ${size}`);
    }
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

interface MapRelationType<T> {
  // FIXME: Not sure why we need the RemoveEmptyObject, we should somehow fix at the source where it's added to the union
  one: RemoveEmptyObject<T> | null;
  many: RemoveEmptyObject<T>[];
}

/**
 * Join builder with indexed-only where clauses for Unit of Work
 * TJoinOut accumulates the types of all joined relations
 */
export type IndexedJoinBuilder<TTable extends AnyTable, TJoinOut> = {
  [K in keyof TTable["relations"]]: TTable["relations"][K] extends Relation<
    infer TRelationType,
    infer TTargetTable
  >
    ? <TSelect extends SelectClause<TTable["relations"][K]["table"]> = true, TNestedJoinOut = {}>(
        builderFn?: (
          builder: JoinFindBuilder<TTable["relations"][K]["table"]>,
        ) => JoinFindBuilder<TTable["relations"][K]["table"], TSelect, TNestedJoinOut>,
      ) => IndexedJoinBuilder<
        TTable,
        TJoinOut & {
          [P in K]: MapRelationType<
            SelectResult<TTargetTable, TNestedJoinOut, TSelect>
          >[TRelationType];
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

/**
 * Full Unit of Work interface with all operations including execution.
 * This allows UOW instances to be passed between different contexts that use different schemas.
 */
export interface IUnitOfWork {
  // Getters (schema-agnostic)
  readonly state: UOWState;
  readonly name: string | undefined;
  readonly nonce: string;
  readonly retrievalPhase: Promise<unknown[]>;
  readonly mutationPhase: Promise<void>;

  // Execution (schema-agnostic)
  executeRetrieve(): Promise<unknown[]>;
  executeMutations(): Promise<{ success: boolean }>;

  // Inspection (schema-agnostic)
  getRetrievalOperations(): ReadonlyArray<RetrievalOperation<AnySchema>>;
  getMutationOperations(): ReadonlyArray<MutationOperation<AnySchema>>;
  getCreatedIds(): FragnoId[];

  // Parent-child relationships
  restrict(options?: { readyFor?: "mutation" | "retrieval" | "none" }): IUnitOfWork;

  // Coordination for restricted UOWs
  signalReadyForRetrieval(): void;
  signalReadyForMutation(): void;

  // Reset for retry support
  reset(): void;

  // Schema-specific view (for cross-schema operations)
  // The optional hooks parameter is for type inference only - pass your hooks map
  // to get proper typing for triggerHook. The value is not used at runtime.
  forSchema<TOtherSchema extends AnySchema, TOtherHooks extends HooksMap = {}>(
    schema: TOtherSchema,
    hooks?: TOtherHooks,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): TypedUnitOfWork<TOtherSchema, [], any, TOtherHooks>;

  // Schema registration (for cross-fragment operations like hooks)
  registerSchema(schema: AnySchema, namespace: string): void;

  // Hook triggering (schema-agnostic, string-based hook names)
  triggerHook(hookName: string, payload: unknown, options?: TriggerHookOptions): void;

  getTriggeredHooks(): readonly TriggeredHook[];
}

/**
 * Restricted UOW interface without execute methods.
 * Useful when you want to allow building operations but not executing them,
 * to prevent deadlocks or enforce execution control at a higher level.
 *
 * Note: This is just a marker interface. Restriction is enforced by the UnitOfWork class itself.
 */
export interface IUnitOfWorkRestricted
  extends Omit<IUnitOfWork, "executeRetrieve" | "executeMutations"> {}

export function createUnitOfWork(
  compiler: UOWCompiler<unknown>,
  executor: UOWExecutor<unknown, unknown>,
  decoder: UOWDecoder<unknown>,
  schemaNamespaceMap?: WeakMap<AnySchema, string>,
  name?: string,
): UnitOfWork {
  return new UnitOfWork(compiler, executor, decoder, name, undefined, schemaNamespaceMap);
}

export interface UnitOfWorkConfig {
  dryRun?: boolean;
  onQuery?: (query: unknown) => void;
  nonce?: string;
}

/**
 * Encapsulates a promise with its resolver/rejecter functions.
 * Simplifies management of deferred promises with built-in error handling.
 */
class DeferredPromise<T> {
  #resolve?: (value: T) => void;
  #reject?: (error: Error) => void;
  #promise: Promise<T>;

  constructor() {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    this.#promise = promise;
    this.#resolve = resolve;
    this.#reject = reject;
    // Attach no-op error handler to prevent unhandled rejection warnings
    this.#promise.catch(() => {});
  }

  get promise(): Promise<T> {
    return this.#promise;
  }

  resolve(value: T): void {
    this.#resolve?.(value);
  }

  reject(error: Error): void {
    this.#reject?.(error);
  }

  /**
   * Reset to a new promise
   */
  reset(): void {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    this.#promise = promise;
    this.#resolve = resolve;
    this.#reject = reject;
    // Attach no-op error handler to prevent unhandled rejection warnings
    this.#promise.catch(() => {});
  }
}

/**
 * Tracks readiness signals from a group of children.
 * Maintains a promise that resolves when all registered children have signaled.
 */
class ReadinessTracker {
  #expectedCount = 0;
  #signalCount = 0;
  #resolve?: () => void;
  #promise: Promise<void> = Promise.resolve();

  get promise(): Promise<void> {
    return this.#promise;
  }

  /**
   * Register that we're expecting a signal from a child
   */
  registerChild(): void {
    if (this.#expectedCount === 0) {
      // First child - create new promise
      const { promise, resolve } = Promise.withResolvers<void>();
      this.#promise = promise;
      this.#resolve = resolve;
    }
    this.#expectedCount++;
  }

  /**
   * Signal that one child is ready
   */
  signal(): void {
    this.#signalCount++;
    if (this.#signalCount >= this.#expectedCount && this.#resolve) {
      this.#resolve();
    }
  }

  /**
   * Reset to initial state
   */
  reset(): void {
    this.#expectedCount = 0;
    this.#signalCount = 0;
    this.#resolve = undefined;
    this.#promise = Promise.resolve();
  }
}

/**
 * Manages parent-child relationships and readiness coordination for Unit of Work instances.
 * This allows parent UOWs to wait for all child UOWs to signal readiness before executing phases.
 */
class UOWChildCoordinator<TRawInput> {
  #parent: UnitOfWork<TRawInput> | null = null;
  #parentCoordinator: UOWChildCoordinator<TRawInput> | null = null;
  #children: Set<UnitOfWork<TRawInput>> = new Set();
  #isRestricted = false;

  #retrievalTracker = new ReadinessTracker();
  #mutationTracker = new ReadinessTracker();

  get isRestricted(): boolean {
    return this.#isRestricted;
  }

  get parent(): UnitOfWork<TRawInput> | null {
    return this.#parent;
  }

  get children(): ReadonlySet<UnitOfWork<TRawInput>> {
    return this.#children;
  }

  get retrievalReadinessPromise(): Promise<void> {
    return this.#retrievalTracker.promise;
  }

  get mutationReadinessPromise(): Promise<void> {
    return this.#mutationTracker.promise;
  }

  /**
   * Mark this UOW as a restricted child of the given parent
   */
  setAsRestricted(
    parent: UnitOfWork<TRawInput>,
    parentCoordinator: UOWChildCoordinator<TRawInput>,
  ): void {
    this.#parent = parent;
    this.#parentCoordinator = parentCoordinator;
    this.#isRestricted = true;
  }

  /**
   * Register a child UOW
   */
  addChild(child: UnitOfWork<TRawInput>): void {
    this.#children.add(child);
    this.#retrievalTracker.registerChild();
    this.#mutationTracker.registerChild();
  }

  /**
   * Signal that this child is ready for retrieval phase execution.
   * Only valid for restricted (child) UOWs.
   */
  signalReadyForRetrieval(): void {
    if (!this.#parentCoordinator) {
      throw new Error("signalReadyForRetrieval() can only be called on restricted child UOWs");
    }

    this.#parentCoordinator.notifyChildReadyForRetrieval();
  }

  /**
   * Signal that this child is ready for mutation phase execution.
   * Only valid for restricted (child) UOWs.
   */
  signalReadyForMutation(): void {
    if (!this.#parentCoordinator) {
      throw new Error("signalReadyForMutation() can only be called on restricted child UOWs");
    }

    this.#parentCoordinator.notifyChildReadyForMutation();
  }

  /**
   * Notify this coordinator that a child is ready for retrieval (internal use).
   * Called by child UOWs when they signal readiness.
   */
  notifyChildReadyForRetrieval(): void {
    this.#retrievalTracker.signal();
  }

  /**
   * Notify this coordinator that a child is ready for mutation (internal use).
   * Called by child UOWs when they signal readiness.
   */
  notifyChildReadyForMutation(): void {
    this.#mutationTracker.signal();
  }

  /**
   * Reset coordination state for retry support
   */
  reset(): void {
    this.#children.clear();
    this.#retrievalTracker.reset();
    this.#mutationTracker.reset();
  }
}

/**
 * Unit of Work implementation with optimistic concurrency control
 *
 * UOW has two phases:
 * 1. Retrieval phase: Read operations to fetch entities with their versions
 * 2. Mutation phase: Write operations that check versions before committing
 *
 * This is the untyped base storage. Use TypedUnitOfWork for type-safe operations.
 *
 * @example
 * ```ts
 * const uow = queryEngine.createUnitOfWork("update-user-balance");
 * const typedUow = uow.forSchema(mySchema);
 *
 * // Retrieval phase
 * typedUow.find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId)));
 *
 * // Execute retrieval and transition to mutation phase
 * const [users] = await uow.executeRetrieve();
 *
 * // Mutation phase with version check
 * const user = users[0];
 * typedUow.update("users", user.id, (b) => b.set({ balance: newBalance }).check());
 *
 * // Execute mutations
 * const { success } = await uow.executeMutations();
 * if (!success) {
 *   // Handle version conflict
 * }
 * ```
 */
export class UnitOfWork<const TRawInput = unknown> implements IUnitOfWork {
  #name?: string;
  #config?: UnitOfWorkConfig;
  #nonce: string;

  #state: UOWState = "building-retrieval";

  // Operations can come from any schema
  #retrievalOps: RetrievalOperation<AnySchema>[] = [];
  #mutationOps: MutationOperation<AnySchema>[] = [];

  #compiler: UOWCompiler<unknown>;
  #executor: UOWExecutor<unknown, TRawInput>;
  #decoder: UOWDecoder<TRawInput>;
  #schemaNamespaceMap: WeakMap<AnySchema, string>;

  #retrievalResults?: unknown[];
  #createdInternalIds: (bigint | null)[] = [];

  // Phase coordination promises
  #retrievalPhaseDeferred = new DeferredPromise<unknown[]>();
  #mutationPhaseDeferred = new DeferredPromise<void>();

  // Error tracking
  #retrievalError: Error | null = null;
  #mutationError: Error | null = null;

  // Child coordination
  #coordinator: UOWChildCoordinator<TRawInput> = new UOWChildCoordinator();

  // Hook triggers
  #triggeredHooks: TriggeredHook[] = [];

  constructor(
    compiler: UOWCompiler<unknown>,
    executor: UOWExecutor<unknown, TRawInput>,
    decoder: UOWDecoder<TRawInput>,
    name?: string,
    config?: UnitOfWorkConfig,
    schemaNamespaceMap?: WeakMap<AnySchema, string>,
  ) {
    this.#compiler = compiler;
    this.#executor = executor;
    this.#decoder = decoder;
    this.#schemaNamespaceMap = schemaNamespaceMap ?? new WeakMap();
    this.#name = name;
    this.#config = config;
    this.#nonce = config?.nonce ?? crypto.randomUUID();
  }

  /**
   * Register a schema with its namespace for cross-fragment operations.
   * This is used for internal fragments like hooks that need to create
   * records in a different schema during the same transaction.
   */
  registerSchema(schema: AnySchema, namespace: string): void {
    this.#schemaNamespaceMap.set(schema, namespace);
  }

  /**
   * Get a schema-specific typed view of this UOW for type-safe operations.
   * Returns a wrapper that provides typed operations for the given schema.
   * The namespace is automatically resolved from the schema-namespace map.
   * The optional hooks parameter is for type inference only - pass your hooks map
   * to get proper typing for triggerHook. The value is not used at runtime.
   */
  forSchema<TOtherSchema extends AnySchema, TOtherHooks extends HooksMap = {}>(
    schema: TOtherSchema,
    _hooks?: TOtherHooks,
  ): TypedUnitOfWork<TOtherSchema, [], TRawInput, TOtherHooks> {
    const resolvedNamespace = this.#schemaNamespaceMap.get(schema);

    return new TypedUnitOfWork<TOtherSchema, [], TRawInput, TOtherHooks>(
      schema,
      resolvedNamespace,
      this,
    );
  }

  /**
   * Create a restricted child UOW that cannot execute phases.
   * The child shares the same operation storage but must signal readiness
   * before the parent can execute each phase.
   *
   * @param options.readyFor - Controls automatic readiness signaling:
   *   - "mutation" (default): Signals ready for both retrieval and mutation immediately
   *   - "retrieval": Signals ready for retrieval only
   *   - "none": No automatic signaling, caller must signal manually
   */
  restrict(options?: { readyFor?: "mutation" | "retrieval" | "none" }): UnitOfWork<TRawInput> {
    const readyFor = options?.readyFor ?? "mutation";

    const child = new UnitOfWork(
      this.#compiler,
      this.#executor,
      this.#decoder,
      this.#name,
      { ...this.#config, nonce: this.#nonce },
      this.#schemaNamespaceMap,
    );
    child.#coordinator.setAsRestricted(this, this.#coordinator);

    child.#retrievalOps = this.#retrievalOps;
    child.#mutationOps = this.#mutationOps;
    child.#retrievalResults = this.#retrievalResults;
    child.#createdInternalIds = this.#createdInternalIds;
    child.#retrievalPhaseDeferred = this.#retrievalPhaseDeferred;
    child.#mutationPhaseDeferred = this.#mutationPhaseDeferred;
    child.#retrievalError = this.#retrievalError;
    child.#mutationError = this.#mutationError;
    child.#triggeredHooks = this.#triggeredHooks;

    this.#coordinator.addChild(child);

    // Signal readiness based on options
    if (readyFor === "mutation" || readyFor === "retrieval") {
      child.signalReadyForRetrieval();
    }
    if (readyFor === "mutation") {
      child.signalReadyForMutation();
    }

    return child;
  }

  /**
   * Signal that this child is ready for retrieval phase execution.
   * Only valid for restricted (child) UOWs.
   */
  signalReadyForRetrieval(): void {
    this.#coordinator.signalReadyForRetrieval();
  }

  /**
   * Signal that this child is ready for mutation phase execution.
   * Only valid for restricted (child) UOWs.
   */
  signalReadyForMutation(): void {
    this.#coordinator.signalReadyForMutation();
  }

  /**
   * Reset the UOW to initial state for retry support.
   * Clears operations, resets state, and resets phase promises.
   */
  reset(): void {
    if (this.#coordinator.isRestricted) {
      throw new Error("reset() cannot be called on restricted child UOWs");
    }

    // Clear operations
    this.#retrievalOps = [];
    this.#mutationOps = [];
    this.#retrievalResults = undefined;
    this.#createdInternalIds = [];

    // Reset state
    this.#state = "building-retrieval";
    this.#retrievalError = null;
    this.#mutationError = null;

    // Reset phase promises
    this.#retrievalPhaseDeferred.reset();
    this.#mutationPhaseDeferred.reset();

    // Reset child coordination
    this.#coordinator.reset();

    // Reset hooks
    this.#triggeredHooks = [];
  }

  /**
   * Trigger a hook to be executed after the transaction commits.
   */
  triggerHook(hookName: string, payload: unknown, options?: TriggerHookOptions): void {
    this.#triggeredHooks.push({
      hookName,
      payload,
      options,
    });
  }

  /**
   * Get all triggered hooks for this UOW.
   */
  getTriggeredHooks(): ReadonlyArray<TriggeredHook> {
    return this.#triggeredHooks;
  }

  get state(): UOWState {
    return this.#coordinator.parent?.state ?? this.#state;
  }

  get name(): string | undefined {
    return this.#name;
  }

  get nonce(): string {
    return this.#nonce;
  }

  /**
   * Promise that resolves when the retrieval phase is executed
   * Service methods can await this to coordinate multi-phase logic
   */
  get retrievalPhase(): Promise<unknown[]> {
    return this.#retrievalPhaseDeferred.promise;
  }

  /**
   * Promise that resolves when the mutation phase is executed
   * Service methods can await this to coordinate multi-phase logic
   */
  get mutationPhase(): Promise<void> {
    return this.#mutationPhaseDeferred.promise;
  }

  /**
   * Execute the retrieval phase and transition to mutation phase
   * Returns all results from find operations
   */
  async executeRetrieve(): Promise<unknown[]> {
    if (this.#coordinator.isRestricted) {
      throw new Error("executeRetrieve() cannot be called on restricted child UOWs");
    }

    if (this.#state !== "building-retrieval") {
      throw new Error(
        `Cannot execute retrieval from state ${this.#state}. Must be in building-retrieval state.`,
      );
    }

    try {
      // Wait for all children to signal readiness
      await this.#coordinator.retrievalReadinessPromise;

      if (this.#retrievalOps.length === 0) {
        this.#state = "building-mutation";
        const emptyResults: unknown[] = [];
        this.#retrievalPhaseDeferred.resolve(emptyResults);
        return emptyResults;
      }

      // Compile retrieval operations using single compiler
      const retrievalBatch: unknown[] = [];
      for (const op of this.#retrievalOps) {
        const compiled = this.#compiler.compileRetrievalOperation(op);
        if (compiled !== null) {
          this.#config?.onQuery?.(compiled);
          retrievalBatch.push(compiled);
        }
      }

      if (this.#config?.dryRun) {
        this.#state = "executed";
        const emptyResults: unknown[] = [];
        this.#retrievalPhaseDeferred.resolve(emptyResults);
        return emptyResults;
      }

      const rawResults = await this.#executor.executeRetrievalPhase(retrievalBatch);

      const results = this.#decoder.decode(rawResults, this.#retrievalOps);

      // Store results and transition to mutation phase
      this.#retrievalResults = results;
      this.#state = "building-mutation";

      this.#retrievalPhaseDeferred.resolve(this.#retrievalResults);

      return this.#retrievalResults;
    } catch (error) {
      this.#retrievalError = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  /**
   * Execute the mutation phase
   * Returns success flag indicating if mutations completed without conflicts
   */
  async executeMutations(): Promise<{ success: boolean }> {
    if (this.#coordinator.isRestricted) {
      throw new Error("executeMutations() cannot be called on restricted child UOWs");
    }

    if (this.#state === "executed") {
      throw new Error(`Cannot execute mutations from state ${this.#state}.`);
    }

    try {
      // Wait for all children to signal readiness
      await this.#coordinator.mutationReadinessPromise;

      // Compile mutation operations using single compiler
      const mutationBatch: CompiledMutation<unknown>[] = [];
      for (const op of this.#mutationOps) {
        const compiled = this.#compiler.compileMutationOperation(op);
        if (compiled !== null) {
          this.#config?.onQuery?.(compiled);
          mutationBatch.push(compiled);
        }
      }

      if (this.#config?.dryRun) {
        this.#state = "executed";
        this.#mutationPhaseDeferred.resolve();
        return {
          success: true,
        };
      }

      // Execute mutation phase
      const result = await this.#executor.executeMutationPhase(mutationBatch);
      this.#state = "executed";

      if (result.success) {
        // Mutate array in-place to preserve shared references with child UOWs
        this.#createdInternalIds.length = 0;
        this.#createdInternalIds.push(...result.createdInternalIds);
      }

      // Resolve the mutation phase promise to unblock waiting service methods
      this.#mutationPhaseDeferred.resolve();

      return {
        success: result.success,
      };
    } catch (error) {
      this.#mutationError = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  /**
   * Get the retrieval operations (for inspection/debugging)
   */
  getRetrievalOperations(): ReadonlyArray<RetrievalOperation<AnySchema>> {
    return this.#retrievalOps;
  }

  /**
   * Get the mutation operations (for inspection/debugging)
   */
  getMutationOperations(): ReadonlyArray<MutationOperation<AnySchema>> {
    return this.#mutationOps;
  }

  /**
   * @internal
   * Add a retrieval operation (used by TypedUnitOfWork)
   */
  addRetrievalOperation(op: RetrievalOperation<AnySchema>): number {
    if (this.state !== "building-retrieval") {
      throw new Error(
        `Cannot add retrieval operation in state ${this.state}. Must be in building-retrieval state.`,
      );
    }
    this.#retrievalOps.push(op);
    return this.#retrievalOps.length - 1;
  }

  /**
   * @internal
   * Add a mutation operation (used by TypedUnitOfWork)
   */
  addMutationOperation(op: MutationOperation<AnySchema>): void {
    if (this.state === "executed") {
      throw new Error(`Cannot add mutation operation in executed state.`);
    }
    this.#mutationOps.push(op);
  }

  /**
   * Get the IDs of created entities after executeMutations() has been called.
   * Returns FragnoId objects with external IDs (always available) and internal IDs
   * (available when database supports RETURNING).
   *
   * @throws Error if called before executeMutations()
   * @returns Array of FragnoIds in the same order as create() calls
   */
  getCreatedIds(): FragnoId[] {
    if (this.state !== "executed") {
      throw new Error(
        `getCreatedIds() can only be called after executeMutations(). Current state: ${this.state}`,
      );
    }

    const createdIds: FragnoId[] = [];
    let createIndex = 0;

    for (const op of this.#mutationOps) {
      if (op.type === "create") {
        const internalId = this.#createdInternalIds[createIndex] ?? undefined;
        createdIds.push(
          new FragnoId({
            externalId: op.generatedExternalId,
            internalId,
            version: 0, // New records always start at version 0
          }),
        );
        createIndex++;
      }
    }

    return createdIds;
  }

  /**
   * @internal
   * Compile the unit of work to executable queries for testing
   */
  compile<TOutput>(compiler: UOWCompiler<TOutput>): {
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

/**
 * A typed facade around a UnitOfWork that provides type-safe operations for a specific schema.
 * All operations are stored in the underlying UOW, but this facade ensures type safety and
 * filters retrieval results to only include operations added through this facade.
 */
export class TypedUnitOfWork<
  const TSchema extends AnySchema,
  const TRetrievalResults extends unknown[] = [],
  const TRawInput = unknown,
  const THooks extends HooksMap = {},
> implements IUnitOfWork
{
  #schema: TSchema;
  #namespace?: string;
  #uow: UnitOfWork<TRawInput>;
  #operationIndices: number[] = [];
  #cachedRetrievalPhase?: Promise<TRetrievalResults>;

  constructor(schema: TSchema, namespace: string | undefined, uow: UnitOfWork<TRawInput>) {
    this.#schema = schema;
    this.#namespace = namespace;
    this.#uow = uow;
  }

  get $results(): Prettify<TRetrievalResults> {
    throw new Error("type only");
  }

  get schema(): TSchema {
    return this.#schema;
  }

  get name(): string | undefined {
    return this.#uow.name;
  }

  get nonce(): string {
    return this.#uow.nonce;
  }

  get state() {
    return this.#uow.state;
  }

  get retrievalPhase(): Promise<TRetrievalResults> {
    // Cache the filtered promise to avoid recreating it on every access
    if (!this.#cachedRetrievalPhase) {
      this.#cachedRetrievalPhase = this.#uow.retrievalPhase.then((allResults) => {
        const allOperations = this.#uow.getRetrievalOperations();
        const filteredResults = this.#operationIndices.map((opIndex) => {
          const result = allResults[opIndex];
          const operation = allOperations[opIndex];
          // Transform array to single item for findFirst operations
          if (operation?.type === "find" && operation.withSingleResult) {
            return Array.isArray(result) ? (result[0] ?? null) : result;
          }
          return result;
        });
        return filteredResults as TRetrievalResults;
      });
    }
    return this.#cachedRetrievalPhase;
  }

  get mutationPhase(): Promise<void> {
    return this.#uow.mutationPhase;
  }

  getRetrievalOperations() {
    return this.#uow.getRetrievalOperations();
  }

  getMutationOperations() {
    return this.#uow.getMutationOperations();
  }

  getCreatedIds() {
    return this.#uow.getCreatedIds();
  }

  async executeRetrieve(): Promise<TRetrievalResults> {
    return this.#uow.executeRetrieve() as Promise<TRetrievalResults>;
  }

  async executeMutations(): Promise<{ success: boolean }> {
    return this.#uow.executeMutations();
  }

  restrict(options?: { readyFor?: "mutation" | "retrieval" | "none" }): IUnitOfWork {
    return this.#uow.restrict(options);
  }

  signalReadyForRetrieval(): void {
    this.#uow.signalReadyForRetrieval();
  }

  signalReadyForMutation(): void {
    this.#uow.signalReadyForMutation();
  }

  reset(): void {
    return this.#uow.reset();
  }

  forSchema<TOtherSchema extends AnySchema, TOtherHooks extends HooksMap = {}>(
    schema: TOtherSchema,
    hooks?: TOtherHooks,
  ): TypedUnitOfWork<TOtherSchema, [], TRawInput, TOtherHooks> {
    return this.#uow.forSchema<TOtherSchema, TOtherHooks>(schema, hooks);
  }

  registerSchema(schema: AnySchema, namespace: string): void {
    this.#uow.registerSchema(schema, namespace);
  }

  compile<TOutput>(compiler: UOWCompiler<TOutput>): {
    name?: string;
    retrievalBatch: TOutput[];
    mutationBatch: CompiledMutation<TOutput>[];
  } {
    return this.#uow.compile(compiler);
  }

  find<TTableName extends keyof TSchema["tables"] & string, const TBuilderResult>(
    tableName: TTableName,
    builderFn: (
      builder: Omit<FindBuilder<TSchema["tables"][TTableName]>, "build">,
    ) => TBuilderResult,
  ): TypedUnitOfWork<
    TSchema,
    [
      ...TRetrievalResults,
      SelectResult<
        TSchema["tables"][TTableName],
        ExtractJoinOut<TBuilderResult>,
        Extract<ExtractSelect<TBuilderResult>, SelectClause<TSchema["tables"][TTableName]>>
      >[],
    ],
    TRawInput,
    THooks
  >;
  find<TTableName extends keyof TSchema["tables"] & string>(
    tableName: TTableName,
  ): TypedUnitOfWork<
    TSchema,
    [...TRetrievalResults, SelectResult<TSchema["tables"][TTableName], {}, true>[]],
    TRawInput,
    THooks
  >;
  find<TTableName extends keyof TSchema["tables"] & string, const TBuilderResult>(
    tableName: TTableName,
    builderFn?: (
      builder: Omit<FindBuilder<TSchema["tables"][TTableName]>, "build">,
    ) => TBuilderResult,
  ): TypedUnitOfWork<
    TSchema,
    [
      ...TRetrievalResults,
      SelectResult<
        TSchema["tables"][TTableName],
        ExtractJoinOut<TBuilderResult>,
        Extract<ExtractSelect<TBuilderResult>, SelectClause<TSchema["tables"][TTableName]>>
      >[],
    ],
    TRawInput,
    THooks
  > {
    const table = this.#schema.tables[tableName];
    if (!table) {
      throw new Error(`Table ${tableName} not found in schema`);
    }

    const builder = new FindBuilder(tableName, table as TSchema["tables"][TTableName]);
    if (builderFn) {
      builderFn(builder);
    } else {
      builder.whereIndex("primary");
    }
    const { indexName, options, type } = builder.build();

    const operationIndex = this.#uow.addRetrievalOperation({
      type,
      schema: this.#schema,
      namespace: this.#namespace,
      table: table as TSchema["tables"][TTableName],
      indexName,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options: options as any,
    });

    // Track which operation index belongs to this view
    this.#operationIndices.push(operationIndex);

    // Safe: return type is correctly specified in the method signature
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this as any;
  }

  findFirst<TTableName extends keyof TSchema["tables"] & string, const TBuilderResult>(
    tableName: TTableName,
    builderFn: (
      builder: Omit<FindBuilder<TSchema["tables"][TTableName]>, "build">,
    ) => TBuilderResult,
  ): TypedUnitOfWork<
    TSchema,
    [
      ...TRetrievalResults,
      SelectResult<
        TSchema["tables"][TTableName],
        ExtractJoinOut<TBuilderResult>,
        Extract<ExtractSelect<TBuilderResult>, SelectClause<TSchema["tables"][TTableName]>>
      > | null,
    ],
    TRawInput,
    THooks
  >;
  findFirst<TTableName extends keyof TSchema["tables"] & string>(
    tableName: TTableName,
  ): TypedUnitOfWork<
    TSchema,
    [...TRetrievalResults, SelectResult<TSchema["tables"][TTableName], {}, true> | null],
    TRawInput,
    THooks
  >;
  findFirst<TTableName extends keyof TSchema["tables"] & string, const TBuilderResult>(
    tableName: TTableName,
    builderFn?: (
      builder: Omit<FindBuilder<TSchema["tables"][TTableName]>, "build">,
    ) => TBuilderResult,
  ): TypedUnitOfWork<
    TSchema,
    [
      ...TRetrievalResults,
      SelectResult<
        TSchema["tables"][TTableName],
        ExtractJoinOut<TBuilderResult>,
        Extract<ExtractSelect<TBuilderResult>, SelectClause<TSchema["tables"][TTableName]>>
      > | null,
    ],
    TRawInput,
    THooks
  > {
    const table = this.#schema.tables[tableName];
    if (!table) {
      throw new Error(`Table ${tableName} not found in schema`);
    }

    const builder = new FindBuilder(tableName, table as TSchema["tables"][TTableName]);
    if (builderFn) {
      builderFn(builder);
    } else {
      builder.whereIndex("primary");
    }
    // Automatically set pageSize to 1 for findFirst
    builder.pageSize(1);
    const { indexName, options, type } = builder.build();

    const operationIndex = this.#uow.addRetrievalOperation({
      type,
      schema: this.#schema,
      namespace: this.#namespace,
      table: table as TSchema["tables"][TTableName],
      indexName,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options: options as any,
      withSingleResult: true,
    });

    // Track which operation index belongs to this view
    this.#operationIndices.push(operationIndex);

    // Safe: return type is correctly specified in the method signature
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this as any;
  }

  findWithCursor<TTableName extends keyof TSchema["tables"] & string, const TBuilderResult>(
    tableName: TTableName,
    builderFn: (
      builder: Omit<FindBuilder<TSchema["tables"][TTableName]>, "build">,
    ) => TBuilderResult,
  ): TypedUnitOfWork<
    TSchema,
    [
      ...TRetrievalResults,
      CursorResult<
        SelectResult<
          TSchema["tables"][TTableName],
          ExtractJoinOut<TBuilderResult>,
          Extract<ExtractSelect<TBuilderResult>, SelectClause<TSchema["tables"][TTableName]>>
        >
      >,
    ],
    TRawInput,
    THooks
  > {
    const table = this.#schema.tables[tableName];
    if (!table) {
      throw new Error(`Table ${tableName} not found in schema`);
    }

    const builder = new FindBuilder(tableName, table as TSchema["tables"][TTableName]);
    builderFn(builder);
    const { indexName, options, type } = builder.build();

    const operationIndex = this.#uow.addRetrievalOperation({
      type,
      schema: this.#schema,
      namespace: this.#namespace,
      table: table as TSchema["tables"][TTableName],
      indexName,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options: options as any,
      withCursor: true,
    });

    // Track which operation index belongs to this view
    this.#operationIndices.push(operationIndex);

    // Safe: return type is correctly specified in the method signature
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this as any;
  }

  create<TableName extends keyof TSchema["tables"] & string>(
    tableName: TableName,
    values: TableToInsertValues<TSchema["tables"][TableName]>,
  ): FragnoId {
    const tableSchema = this.#schema.tables[tableName];
    if (!tableSchema) {
      throw new Error(`Table ${tableName} not found in schema`);
    }

    const idColumn = tableSchema.getIdColumn();
    let externalId: string;
    let updatedValues = values;

    // Check if ID value is provided in values
    const providedIdValue = (values as Record<string, unknown>)[idColumn.ormName];

    if (providedIdValue !== undefined) {
      // Extract string from FragnoId or use string directly
      if (
        typeof providedIdValue === "object" &&
        providedIdValue !== null &&
        "externalId" in providedIdValue
      ) {
        externalId = (providedIdValue as FragnoId).externalId;
      } else {
        externalId = providedIdValue as string;
      }
    } else {
      // Generate using the column's default configuration
      const generated = idColumn.generateDefaultValue();
      if (generated === undefined) {
        throw new Error(
          `No ID value provided and ID column ${idColumn.ormName} has no default generator`,
        );
      }
      externalId = generated as string;

      // Add the generated ID to values so it's used in the insert
      updatedValues = {
        ...values,
        [idColumn.ormName]: externalId,
      } as TableToInsertValues<TSchema["tables"][TableName]>;
    }

    this.#uow.addMutationOperation({
      type: "create",
      schema: this.#schema,
      namespace: this.#namespace,
      table: tableName,
      values: updatedValues,
      generatedExternalId: externalId,
    });

    return FragnoId.fromExternal(externalId, 0);
  }

  update<TableName extends keyof TSchema["tables"] & string>(
    tableName: TableName,
    id: FragnoId | string,
    builderFn: (
      builder: Omit<UpdateBuilder<TSchema["tables"][TableName]>, "build">,
    ) => Omit<UpdateBuilder<TSchema["tables"][TableName]>, "build"> | void,
  ): void {
    const builder = new UpdateBuilder<TSchema["tables"][TableName]>(tableName, id);
    builderFn(builder);
    const { id: opId, checkVersion, set } = builder.build();

    this.#uow.addMutationOperation({
      type: "update",
      schema: this.#schema,
      namespace: this.#namespace,
      table: tableName,
      id: opId,
      checkVersion,
      set,
    });
  }

  delete<TableName extends keyof TSchema["tables"] & string>(
    tableName: TableName,
    id: FragnoId | string,
    builderFn?: (builder: Omit<DeleteBuilder, "build">) => Omit<DeleteBuilder, "build"> | void,
  ): void {
    const builder = new DeleteBuilder(tableName, id);
    builderFn?.(builder);
    const { id: opId, checkVersion } = builder.build();

    this.#uow.addMutationOperation({
      type: "delete",
      schema: this.#schema,
      namespace: this.#namespace,
      table: tableName,
      id: opId,
      checkVersion,
    });
  }

  /**
   * Check that a record's version hasn't changed since retrieval.
   * This is useful for ensuring related records remain unchanged during a transaction.
   *
   * @param tableName - The table name
   * @param id - The FragnoId with version information (string IDs are not allowed)
   * @throws Error if the ID is a string without version information
   *
   * @example
   * ```ts
   * // Ensure both accounts haven't changed before creating a transfer
   * uow.check("accounts", fromAccount.id);
   * uow.check("accounts", toAccount.id);
   * uow.create("transactions", { fromAccountId, toAccountId, amount });
   * ```
   */
  check<TableName extends keyof TSchema["tables"] & string>(
    tableName: TableName,
    id: FragnoId,
  ): void {
    this.#uow.addMutationOperation({
      type: "check",
      schema: this.#schema,
      namespace: this.#namespace,
      table: tableName,
      id,
    });
  }

  get $hooks(): THooks {
    throw new Error("type only");
  }

  /**
   * Trigger a hook to be executed after the transaction commits.
   */
  triggerHook<K extends keyof THooks & string>(
    hookName: K,
    payload: HookPayload<THooks[K]>,
    options?: TriggerHookOptions,
  ): void {
    this.#uow.triggerHook(hookName, payload, options);
  }

  getTriggeredHooks(): ReadonlyArray<TriggeredHook> {
    return this.#uow.getTriggeredHooks();
  }
}
