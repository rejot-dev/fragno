import type { AnyColumn, AnySchema, AnyTable, IdColumn, Index } from "../../schema/create";
import { createIndexedBuilder, type Condition, type ConditionBuilder } from "../condition-builder";
import type { Cursor } from "../cursor";
import type { AnySelectClause, SelectClause, SelectResult } from "../mod";

/**
 * Extract column names from a single index.
 */
type IndexColumns<TIndex extends Index> = TIndex["columnNames"][number];

type OmitNever<T> = { [K in keyof T as T[K] extends never ? never : K]: T[K] };
type RemoveEmptyObject<T> = T extends object ? (keyof T extends never ? never : T) : never;

type InferIdColumnName<TTable extends AnyTable> = keyof OmitNever<{
  [K in keyof TTable["columns"]]: TTable["columns"][K] extends IdColumn<
    infer _,
    infer __,
    infer ___
  >
    ? K
    : never;
}>;

type ColumnsForIndex<
  TTable extends AnyTable,
  TIndexName extends QueryTreeValidIndexName<TTable>,
> = TIndexName extends "primary"
  ? Pick<TTable["columns"], InferIdColumnName<TTable>>
  : TIndexName extends keyof TTable["indexes"]
    ? Pick<TTable["columns"], IndexColumns<TTable["indexes"][TIndexName]>>
    : never;

export type QueryTreeValidIndexName<TTable extends AnyTable> =
  | "primary"
  | (string & keyof TTable["indexes"]);

export class ParentColumnRef<TColumn extends AnyColumn = AnyColumn> {
  readonly column: TColumn;

  constructor(column: TColumn) {
    this.column = column;
  }
}

export const isParentColumnRef = (value: unknown): value is ParentColumnRef =>
  value instanceof ParentColumnRef;

type QueryTreeCardinality = "one" | "many";

type MapCardinality<T> = {
  one: RemoveEmptyObject<T> | null;
  many: RemoveEmptyObject<T>[];
};

type CorrelatedConditionValue<TColumn extends AnyColumn> = TColumn["$in"] | ParentColumnRef | null;

export type CorrelatedIndexSpecificConditionBuilder<
  TChildTable extends AnyTable,
  TParentTable extends AnyTable,
  TIndexName extends QueryTreeValidIndexName<TChildTable>,
> = {
  <ColName extends keyof ColumnsForIndex<TChildTable, TIndexName>>(
    a: ColName,
    operator:
      | "="
      | "!="
      | ">"
      | ">="
      | "<"
      | "<="
      | "is"
      | "is not"
      | "contains"
      | "starts with"
      | "ends with"
      | "not contains"
      | "not starts with"
      | "not ends with",
    b: CorrelatedConditionValue<ColumnsForIndex<TChildTable, TIndexName>[ColName]>,
  ): Condition;

  <ColName extends keyof ColumnsForIndex<TChildTable, TIndexName>>(
    a: ColName,
    operator: "in" | "not in",
    b: Array<CorrelatedConditionValue<ColumnsForIndex<TChildTable, TIndexName>[ColName]>>,
  ): Condition;

  <ColName extends keyof ColumnsForIndex<TChildTable, TIndexName>>(a: ColName): Condition;

  and: (...v: (Condition | boolean)[]) => Condition | boolean;
  or: (...v: (Condition | boolean)[]) => Condition | boolean;
  not: (v: Condition | boolean) => Condition | boolean;
  isNull: (a: keyof ColumnsForIndex<TChildTable, TIndexName>) => Condition;
  isNotNull: (a: keyof ColumnsForIndex<TChildTable, TIndexName>) => Condition;
  parent: <ColName extends keyof TParentTable["columns"]>(
    name: ColName,
  ) => ParentColumnRef<TParentTable["columns"][ColName]>;
};

const getIndexedColumnNames = (table: AnyTable, indexName: string): Set<string> => {
  if (indexName === "_primary") {
    return new Set([table.getIdColumn().name]);
  }

  const index = table.indexes[indexName];
  if (!index) {
    throw new Error(`Index "${indexName}" not found on table "${table.name}".`);
  }

  return new Set(index.columnNames as readonly string[]);
};

export function buildCorrelatedCondition<
  TChildTable extends AnyTable,
  TParentTable extends AnyTable,
  TIndexName extends QueryTreeValidIndexName<TChildTable>,
>(
  childTable: TChildTable,
  parentTable: TParentTable,
  indexName: TIndexName,
  input: (
    builder: CorrelatedIndexSpecificConditionBuilder<TChildTable, TParentTable, TIndexName>,
  ) => Condition | boolean,
): Condition | boolean {
  const normalizedIndexName = indexName === "primary" ? "_primary" : indexName;
  const indexedColumns = getIndexedColumnNames(childTable, normalizedIndexName);
  const indexedBuilder = createIndexedBuilder(childTable.columns, indexedColumns);

  const builder = indexedBuilder as unknown as CorrelatedIndexSpecificConditionBuilder<
    TChildTable,
    TParentTable,
    TIndexName
  >;

  builder.parent = ((name) => {
    const column = parentTable.columns[name as string];
    if (!column) {
      throw new Error(`Invalid parent column name ${String(name)}`);
    }
    return new ParentColumnRef(column);
  }) as CorrelatedIndexSpecificConditionBuilder<TChildTable, TParentTable, TIndexName>["parent"];

  return input(builder);
}

export type QueryTreeOrderBy = {
  indexName: string;
  direction: "asc" | "desc";
};

export interface CompiledQueryTreeChildNode<TTable extends AnyTable = AnyTable> {
  kind: "child";
  alias: string;
  table: TTable;
  cardinality: QueryTreeCardinality;
  onIndexName: string;
  onIndex?: Condition;
  where?: Condition;
  select: AnySelectClause;
  orderByIndex?: QueryTreeOrderBy;
  pageSize?: number;
  children: CompiledQueryTreeChildNode[];
}

export interface CompiledQueryTreeRootNode<TTable extends AnyTable = AnyTable> {
  kind: "root";
  table: TTable;
  useIndex: string;
  where?: Condition;
  select: AnySelectClause;
  orderByIndex?: QueryTreeOrderBy;
  after?: Cursor | string;
  before?: Cursor | string;
  pageSize?: number;
  children: CompiledQueryTreeChildNode[];
}

export interface CompiledQueryTreeCountNode<TTable extends AnyTable = AnyTable> {
  kind: "count";
  table: TTable;
  useIndex: string;
  where?: Condition;
}

export interface QueryTreeCountBuilderMarker {
  readonly __queryTreeCount: true;
}

export type ExtractQueryTreeBuilderCount<T> = T extends QueryTreeCountBuilderMarker ? true : false;

export function getQueryTreeSelectedColumnNames(
  table: AnyTable,
  select: AnySelectClause,
  extraColumnNames: readonly string[] = [],
): string[] {
  const selected = Array.isArray(select) ? [...select] : Object.keys(table.columns);
  const result = new Set<string>(selected);

  for (const extra of extraColumnNames) {
    result.add(extra);
  }

  for (const key in table.columns) {
    if (table.columns[key]?.isHidden) {
      result.add(key);
    }
  }

  return Array.from(result);
}

export type ExtractQueryTreeBuilderSelect<T> =
  T extends QueryTreeFindBuilder<infer _, infer __, infer TSelect, infer ___>
    ? TSelect
    : T extends QueryTreeJoinBuilder<infer _, infer __, infer ___, infer TSelect, infer ____>
      ? TSelect
      : true;

export type ExtractQueryTreeBuilderOut<T> =
  T extends QueryTreeFindBuilder<infer _, infer __, infer ___, infer TJoinOut>
    ? TJoinOut
    : T extends QueryTreeJoinBuilder<infer _, infer __, infer ___, infer ____, infer TJoinOut>
      ? TJoinOut
      : {};

export class QueryTreeJoinBuilder<
  TSchema extends AnySchema,
  TTable extends AnyTable,
  TParentTable extends AnyTable,
  TSelect extends SelectClause<TTable> = true,
  TJoinOut = {},
> {
  readonly #schema: TSchema;
  readonly #table: TTable;
  readonly #tableName: string;
  readonly #parentTable: TParentTable;

  #onIndexName?: string;
  #onIndexCondition?: Condition;
  #whereCondition?: Condition;
  #selectClause?: TSelect;
  #orderByIndexClause?: QueryTreeOrderBy;
  #pageSizeValue?: number;
  #children: CompiledQueryTreeChildNode[] = [];

  constructor(schema: TSchema, tableName: string, table: TTable, parentTable: TParentTable) {
    this.#schema = schema;
    this.#tableName = tableName;
    this.#table = table;
    this.#parentTable = parentTable;
  }

  onIndex<TIndexName extends QueryTreeValidIndexName<TTable>>(
    indexName: TIndexName,
    condition?: (
      eb: CorrelatedIndexSpecificConditionBuilder<TTable, TParentTable, TIndexName>,
    ) => Condition | boolean,
  ): this {
    if (indexName !== "primary" && !(indexName in this.#table.indexes)) {
      throw new Error(
        `Index "${String(indexName)}" not found on table "${this.#tableName}". ` +
          `Available indexes: primary, ${Object.keys(this.#table.indexes).join(", ")}`,
      );
    }

    this.#onIndexName = indexName === "primary" ? "_primary" : indexName;
    if (condition) {
      const compiled = buildCorrelatedCondition(
        this.#table,
        this.#parentTable,
        indexName,
        condition,
      );
      if (compiled === false) {
        throw new Error(
          `onIndex() cannot compile to false on table "${this.#tableName}" in query-tree joins.`,
        );
      }
      this.#onIndexCondition = compiled === true ? undefined : compiled;
    }
    return this;
  }

  whereIndex<TIndexName extends QueryTreeValidIndexName<TTable>>(
    indexName: TIndexName,
    condition?: (eb: ConditionBuilder<ColumnsForIndex<TTable, TIndexName>>) => Condition | boolean,
  ): this {
    if (indexName !== "primary" && !(indexName in this.#table.indexes)) {
      throw new Error(
        `Index "${String(indexName)}" not found on table "${this.#tableName}". ` +
          `Available indexes: primary, ${Object.keys(this.#table.indexes).join(", ")}`,
      );
    }

    if (condition) {
      const normalizedIndexName = indexName === "primary" ? "_primary" : indexName;
      const indexedColumns = getIndexedColumnNames(this.#table, normalizedIndexName);
      const compiled = condition(
        createIndexedBuilder(this.#table.columns, indexedColumns) as unknown as ConditionBuilder<
          ColumnsForIndex<TTable, TIndexName>
        >,
      );
      if (compiled === false) {
        throw new Error(
          `whereIndex() cannot compile to false on table "${this.#tableName}" in query-tree joins.`,
        );
      }
      this.#whereCondition = compiled === true ? undefined : compiled;
    }
    return this;
  }

  select<const TNewSelect extends SelectClause<TTable>>(
    columns: TNewSelect,
  ): QueryTreeJoinBuilder<TSchema, TTable, TParentTable, TNewSelect, TJoinOut> {
    // prettier-ignore
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).#selectClause = columns;
    return this as unknown as QueryTreeJoinBuilder<
      TSchema,
      TTable,
      TParentTable,
      TNewSelect,
      TJoinOut
    >;
  }

  orderByIndex<TIndexName extends QueryTreeValidIndexName<TTable>>(
    indexName: TIndexName,
    direction: "asc" | "desc",
  ): this {
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

  pageSize(size: number): this {
    if (!Number.isInteger(size) || size <= 0) {
      throw new RangeError(`pageSize must be a positive integer, received: ${size}`);
    }
    this.#pageSizeValue = size;
    return this;
  }

  joinOne<
    const TAlias extends string,
    TTableName extends keyof TSchema["tables"] & string,
    const TBuilderResult,
  >(
    alias: TAlias,
    tableName: TTableName,
    builderFn: (
      builder: QueryTreeJoinBuilder<TSchema, TSchema["tables"][TTableName], TTable>,
    ) => TBuilderResult,
  ): QueryTreeJoinBuilder<
    TSchema,
    TTable,
    TParentTable,
    TSelect,
    TJoinOut & {
      [P in TAlias]: MapCardinality<
        SelectResult<
          TSchema["tables"][TTableName],
          ExtractQueryTreeBuilderOut<TBuilderResult>,
          Extract<
            ExtractQueryTreeBuilderSelect<TBuilderResult>,
            SelectClause<TSchema["tables"][TTableName]>
          >
        >
      >["one"];
    }
  > {
    this.#children.push(this.#buildChildNode(alias, tableName, "one", builderFn));
    return this as unknown as QueryTreeJoinBuilder<
      TSchema,
      TTable,
      TParentTable,
      TSelect,
      TJoinOut & {
        [P in TAlias]: MapCardinality<
          SelectResult<
            TSchema["tables"][TTableName],
            ExtractQueryTreeBuilderOut<TBuilderResult>,
            Extract<
              ExtractQueryTreeBuilderSelect<TBuilderResult>,
              SelectClause<TSchema["tables"][TTableName]>
            >
          >
        >["one"];
      }
    >;
  }

  joinMany<
    const TAlias extends string,
    TTableName extends keyof TSchema["tables"] & string,
    const TBuilderResult,
  >(
    alias: TAlias,
    tableName: TTableName,
    builderFn: (
      builder: QueryTreeJoinBuilder<TSchema, TSchema["tables"][TTableName], TTable>,
    ) => TBuilderResult,
  ): QueryTreeJoinBuilder<
    TSchema,
    TTable,
    TParentTable,
    TSelect,
    TJoinOut & {
      [P in TAlias]: MapCardinality<
        SelectResult<
          TSchema["tables"][TTableName],
          ExtractQueryTreeBuilderOut<TBuilderResult>,
          Extract<
            ExtractQueryTreeBuilderSelect<TBuilderResult>,
            SelectClause<TSchema["tables"][TTableName]>
          >
        >
      >["many"];
    }
  > {
    this.#children.push(this.#buildChildNode(alias, tableName, "many", builderFn));
    return this as unknown as QueryTreeJoinBuilder<
      TSchema,
      TTable,
      TParentTable,
      TSelect,
      TJoinOut & {
        [P in TAlias]: MapCardinality<
          SelectResult<
            TSchema["tables"][TTableName],
            ExtractQueryTreeBuilderOut<TBuilderResult>,
            Extract<
              ExtractQueryTreeBuilderSelect<TBuilderResult>,
              SelectClause<TSchema["tables"][TTableName]>
            >
          >
        >["many"];
      }
    >;
  }

  #buildChildNode<TTableName extends keyof TSchema["tables"] & string, const TBuilderResult>(
    alias: string,
    tableName: TTableName,
    cardinality: QueryTreeCardinality,
    builderFn: (
      builder: QueryTreeJoinBuilder<TSchema, TSchema["tables"][TTableName], TTable>,
    ) => TBuilderResult,
  ): CompiledQueryTreeChildNode {
    const childTable = this.#schema.tables[tableName];
    if (!childTable) {
      throw new Error(`Table ${tableName} not found in schema`);
    }

    const childBuilder = new QueryTreeJoinBuilder(
      this.#schema,
      tableName,
      childTable as TSchema["tables"][TTableName],
      this.#table,
    );
    builderFn(childBuilder as QueryTreeJoinBuilder<TSchema, TSchema["tables"][TTableName], TTable>);
    return childBuilder.build(alias, cardinality);
  }

  build(alias: string, cardinality: QueryTreeCardinality): CompiledQueryTreeChildNode<TTable> {
    if (!this.#onIndexName) {
      throw new Error(
        `Must specify an index using .onIndex() before finalizing query-tree join on table "${this.#tableName}"`,
      );
    }

    return {
      kind: "child",
      alias,
      table: this.#table,
      cardinality,
      onIndexName: this.#onIndexName,
      onIndex: this.#onIndexCondition,
      where: this.#whereCondition,
      select: (this.#selectClause ?? true) as AnySelectClause,
      orderByIndex: this.#orderByIndexClause,
      pageSize: this.#pageSizeValue,
      children: [...this.#children],
    };
  }
}

export class QueryTreeFindBuilder<
  TSchema extends AnySchema,
  TTable extends AnyTable,
  TSelect extends SelectClause<TTable> = true,
  TJoinOut = {},
> {
  readonly #schema: TSchema;
  readonly #table: TTable;
  readonly #tableName: string;

  #indexName?: string;
  #whereClause?: Condition;
  #selectClause?: TSelect;
  #orderByIndexClause?: QueryTreeOrderBy;
  #afterCursor?: Cursor | string;
  #beforeCursor?: Cursor | string;
  #pageSizeValue?: number;
  #cursorMetadata?: Cursor;
  #children: CompiledQueryTreeChildNode[] = [];
  #countMode = false;

  constructor(schema: TSchema, tableName: string, table: TTable) {
    this.#schema = schema;
    this.#tableName = tableName;
    this.#table = table;
  }

  whereIndex<TIndexName extends QueryTreeValidIndexName<TTable>>(
    indexName: TIndexName,
    condition?: (eb: ConditionBuilder<ColumnsForIndex<TTable, TIndexName>>) => Condition | boolean,
  ): this {
    if (indexName !== "primary" && !(indexName in this.#table.indexes)) {
      throw new Error(
        `Index "${String(indexName)}" not found on table "${this.#tableName}". ` +
          `Available indexes: primary, ${Object.keys(this.#table.indexes).join(", ")}`,
      );
    }

    this.#indexName = indexName === "primary" ? "_primary" : indexName;
    if (condition) {
      const indexedColumns = getIndexedColumnNames(this.#table, this.#indexName);
      const compiled = condition(
        createIndexedBuilder(this.#table.columns, indexedColumns) as unknown as ConditionBuilder<
          ColumnsForIndex<TTable, TIndexName>
        >,
      );
      if (compiled === false) {
        throw new Error(
          `whereIndex() cannot compile to false on table "${this.#tableName}" in findNew().`,
        );
      }
      this.#whereClause = compiled === true ? undefined : compiled;
    }
    return this;
  }

  select<const TNewSelect extends SelectClause<TTable>>(
    columns: TNewSelect,
  ): QueryTreeFindBuilder<TSchema, TTable, TNewSelect, TJoinOut> {
    if (this.#countMode) {
      throw new Error(
        `Cannot call select() after selectCount() on table "${this.#tableName}". ` +
          `Use either select() or selectCount(), not both.`,
      );
    }
    // prettier-ignore
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).#selectClause = columns;
    return this as unknown as QueryTreeFindBuilder<TSchema, TTable, TNewSelect, TJoinOut>;
  }

  selectCount(): this & QueryTreeCountBuilderMarker {
    if (this.#selectClause !== undefined) {
      throw new Error(
        `Cannot call selectCount() after select() on table "${this.#tableName}". ` +
          `Use either select() or selectCount(), not both.`,
      );
    }
    this.#countMode = true;
    return this as this & QueryTreeCountBuilderMarker;
  }

  orderByIndex<TIndexName extends QueryTreeValidIndexName<TTable>>(
    indexName: TIndexName,
    direction: "asc" | "desc",
  ): this {
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

  after(cursor: Cursor | string): this {
    this.#afterCursor = cursor;
    if (typeof cursor !== "string") {
      this.#cursorMetadata = cursor;
    }
    return this;
  }

  before(cursor: Cursor | string): this {
    this.#beforeCursor = cursor;
    if (typeof cursor !== "string") {
      this.#cursorMetadata = cursor;
    }
    return this;
  }

  pageSize(size: number): this {
    if (!Number.isInteger(size) || size <= 0) {
      throw new RangeError(`pageSize must be a positive integer, received: ${size}`);
    }
    this.#pageSizeValue = size;
    return this;
  }

  joinOne<
    const TAlias extends string,
    TTableName extends keyof TSchema["tables"] & string,
    const TBuilderResult,
  >(
    alias: TAlias,
    tableName: TTableName,
    builderFn: (
      builder: QueryTreeJoinBuilder<TSchema, TSchema["tables"][TTableName], TTable>,
    ) => TBuilderResult,
  ): QueryTreeFindBuilder<
    TSchema,
    TTable,
    TSelect,
    TJoinOut & {
      [P in TAlias]: MapCardinality<
        SelectResult<
          TSchema["tables"][TTableName],
          ExtractQueryTreeBuilderOut<TBuilderResult>,
          Extract<
            ExtractQueryTreeBuilderSelect<TBuilderResult>,
            SelectClause<TSchema["tables"][TTableName]>
          >
        >
      >["one"];
    }
  > {
    this.#children.push(this.#buildChildNode(alias, tableName, "one", builderFn));
    return this as unknown as QueryTreeFindBuilder<
      TSchema,
      TTable,
      TSelect,
      TJoinOut & {
        [P in TAlias]: MapCardinality<
          SelectResult<
            TSchema["tables"][TTableName],
            ExtractQueryTreeBuilderOut<TBuilderResult>,
            Extract<
              ExtractQueryTreeBuilderSelect<TBuilderResult>,
              SelectClause<TSchema["tables"][TTableName]>
            >
          >
        >["one"];
      }
    >;
  }

  joinMany<
    const TAlias extends string,
    TTableName extends keyof TSchema["tables"] & string,
    const TBuilderResult,
  >(
    alias: TAlias,
    tableName: TTableName,
    builderFn: (
      builder: QueryTreeJoinBuilder<TSchema, TSchema["tables"][TTableName], TTable>,
    ) => TBuilderResult,
  ): QueryTreeFindBuilder<
    TSchema,
    TTable,
    TSelect,
    TJoinOut & {
      [P in TAlias]: MapCardinality<
        SelectResult<
          TSchema["tables"][TTableName],
          ExtractQueryTreeBuilderOut<TBuilderResult>,
          Extract<
            ExtractQueryTreeBuilderSelect<TBuilderResult>,
            SelectClause<TSchema["tables"][TTableName]>
          >
        >
      >["many"];
    }
  > {
    this.#children.push(this.#buildChildNode(alias, tableName, "many", builderFn));
    return this as unknown as QueryTreeFindBuilder<
      TSchema,
      TTable,
      TSelect,
      TJoinOut & {
        [P in TAlias]: MapCardinality<
          SelectResult<
            TSchema["tables"][TTableName],
            ExtractQueryTreeBuilderOut<TBuilderResult>,
            Extract<
              ExtractQueryTreeBuilderSelect<TBuilderResult>,
              SelectClause<TSchema["tables"][TTableName]>
            >
          >
        >["many"];
      }
    >;
  }

  #buildChildNode<TTableName extends keyof TSchema["tables"] & string, const TBuilderResult>(
    alias: string,
    tableName: TTableName,
    cardinality: QueryTreeCardinality,
    builderFn: (
      builder: QueryTreeJoinBuilder<TSchema, TSchema["tables"][TTableName], TTable>,
    ) => TBuilderResult,
  ): CompiledQueryTreeChildNode {
    const childTable = this.#schema.tables[tableName];
    if (!childTable) {
      throw new Error(`Table ${tableName} not found in schema`);
    }

    const childBuilder = new QueryTreeJoinBuilder(
      this.#schema,
      tableName,
      childTable as TSchema["tables"][TTableName],
      this.#table,
    );
    builderFn(childBuilder as QueryTreeJoinBuilder<TSchema, TSchema["tables"][TTableName], TTable>);
    return childBuilder.build(alias, cardinality);
  }

  build(): CompiledQueryTreeRootNode<TTable> | CompiledQueryTreeCountNode<TTable> {
    let indexName = this.#indexName;
    let orderByIndex = this.#orderByIndexClause;
    let pageSize = this.#pageSizeValue;

    if (this.#cursorMetadata) {
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
        `Must specify an index using .whereIndex() before finalizing findNew() on table "${this.#tableName}"`,
      );
    }

    if (this.#countMode) {
      if (this.#children.length > 0) {
        throw new Error(
          `Cannot use joinOne() or joinMany() with selectCount() on table "${this.#tableName}".`,
        );
      }
      if (this.#afterCursor !== undefined || this.#beforeCursor !== undefined) {
        throw new Error(
          `Cannot use cursor pagination with selectCount() on table "${this.#tableName}".`,
        );
      }

      return {
        kind: "count",
        table: this.#table,
        useIndex: indexName,
        where: this.#whereClause,
      };
    }

    return {
      kind: "root",
      table: this.#table,
      useIndex: indexName,
      where: this.#whereClause,
      select: (this.#selectClause ?? true) as AnySelectClause,
      orderByIndex,
      after: this.#afterCursor,
      before: this.#beforeCursor,
      pageSize,
      children: [...this.#children],
    };
  }
}
