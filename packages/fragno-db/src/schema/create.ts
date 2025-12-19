import { createId } from "../id";

export type AnySchema = Schema<Record<string, AnyTable>>;

export type AnyRelation = Relation;

export type AnyTable = Table;

export type AnyColumn =
  | Column<keyof TypeMap, unknown, unknown>
  | IdColumn<IdColumnType, unknown, unknown>
  | InternalIdColumn<unknown, unknown>
  | VersionColumn<unknown, unknown>;
/**
 * Sub-operations that can be performed within table operations.
 * These are stored in order within add-table and alter-table operations.
 */
export type TableSubOperation =
  | { type: "add-column"; columnName: string; column: AnyColumn }
  | { type: "add-index"; name: string; columns: string[]; unique: boolean }
  | {
      type: "add-foreign-key";
      name: string;
      columns: string[];
      referencedTable: string;
      referencedColumns: string[];
    };

/**
 * Operations that can be performed on a schema during its definition.
 * These are tracked so we can generate migrations for specific version ranges.
 */
export type SchemaOperation =
  | {
      type: "add-table";
      tableName: string;
      operations: TableSubOperation[]; // Ordered list of sub-operations
    }
  | {
      type: "alter-table";
      tableName: string;
      operations: TableSubOperation[]; // Ordered list of sub-operations
    }
  | {
      type: "add-reference";
      tableName: string; // The table that has the foreign key
      referenceName: string;
      config: {
        type: "one" | "many";
        from: { table: string; column: string };
        to: { table: string; column: string };
      };
    };

export interface ForeignKey {
  name: string;
  table: AnyTable;
  columns: AnyColumn[];

  referencedTable: AnyTable;
  referencedColumns: AnyColumn[];
}

class RelationInit<
  TRelationType extends RelationType,
  TTables extends Record<string, AnyTable>,
  TTableName extends keyof TTables,
> {
  type: TRelationType;
  referencedTable: TTables[TTableName];
  referencer: AnyTable;
  on: [string, string][] = [];

  constructor(type: TRelationType, referencedTable: TTables[TTableName], referencer: AnyTable) {
    this.type = type;
    this.referencedTable = referencedTable;
    this.referencer = referencer;
  }
}

export interface Index<
  TColumns extends AnyColumn[] = AnyColumn[],
  TColumnNames extends readonly string[] = readonly string[],
> {
  name: string;
  columns: TColumns;
  columnNames: TColumnNames;
  unique: boolean;
}

export class ExplicitRelationInit<
  TRelationType extends RelationType,
  TTables extends Record<string, AnyTable>,
  TTableName extends keyof TTables,
> extends RelationInit<TRelationType, TTables, TTableName> {
  init(ormName: string): Relation<TRelationType, TTables[TTableName]> {
    const id = `${this.referencer.ormName}_${this.referencedTable.ormName}`;

    return {
      id,
      on: this.on,
      name: ormName,
      referencer: this.referencer,
      table: this.referencedTable,
      type: this.type,
    };
  }
}

export interface Relation<
  TRelationType extends RelationType = RelationType,
  TTable extends AnyTable = AnyTable,
> {
  id: string;
  name: string;
  type: TRelationType;

  table: TTable;
  referencer: AnyTable;

  on: [string, string][];
}

export interface Table<
  TColumns extends Record<string, AnyColumn> = Record<string, AnyColumn>,
  TRelations extends Record<string, AnyRelation> = Record<string, AnyRelation>,
  TIndexes extends Record<string, Index> = Record<string, Index>,
> {
  name: string;
  ormName: string;

  columns: TColumns;
  relations: TRelations;
  indexes: TIndexes;

  /**
   * Get column by name
   */
  getColumnByName: (name: string) => AnyColumn | undefined;
  /**
   * Get the external ID column (user-facing)
   */
  getIdColumn: () => AnyColumn;
  /**
   * Get the internal ID column (database-native, used for joins)
   */
  getInternalIdColumn: () => AnyColumn;
  /**
   * Get the version column (for optimistic concurrency control)
   */
  getVersionColumn: () => AnyColumn;
}

type DBSpecial = { tag: "special"; value: "now" };
type RuntimeSpecial = { tag: "special"; value: "cuid" | "now" };

/**
 * Builder for database-level default values.
 */
export interface DefaultBuilder {
  /** Database-generated timestamp (DEFAULT NOW()) */
  now(): DBSpecial;
}

/**
 * Builder for runtime-generated default values.
 */
export interface RuntimeDefaultBuilder {
  /** Generate CUID identifier */
  cuid(): RuntimeSpecial;
  /** Generate current timestamp */
  now(): RuntimeSpecial;
}

const defaultBuilder: DefaultBuilder = {
  now: () => ({ tag: "special", value: "now" }),
};

const runtimeDefaultBuilder: RuntimeDefaultBuilder = {
  cuid: () => ({ tag: "special", value: "cuid" }),
  now: () => ({ tag: "special", value: "now" }),
};

type IdColumnType = `varchar(${number})`;

export type TypeMap = {
  string: string;
  bigint: bigint;
  integer: number;
  decimal: number;
  bool: boolean;
  json: unknown;
  /**
   * this follows the same specs as Prisma `Bytes` for consistency.
   */
  binary: Uint8Array;
  date: Date;
  timestamp: Date;
} & Record<`varchar(${number})`, string>;

export class Column<TType extends keyof TypeMap, TIn = unknown, TOut = unknown> {
  type: TType;
  name: string = "";
  ormName: string = "";
  isNullable: boolean = false;
  role: "external-id" | "internal-id" | "version" | "reference" | "regular" = "regular";
  isHidden: boolean = false;

  default?:
    | { value: TypeMap[TType] }
    | { dbSpecial: "now" }
    | { runtime: "cuid" | "now" | (() => TypeMap[TType]) };

  tableName: string = "";

  constructor(type: TType) {
    this.type = type;
  }

  nullable<TNullable extends boolean = true>(nullable?: TNullable) {
    this.isNullable = nullable ?? true;

    return this as Column<
      TType,
      TNullable extends true ? TIn | null : Exclude<TIn, null>,
      TNullable extends true ? TOut | null : Exclude<TOut, null>
    >;
  }

  hidden<THidden extends boolean = true>(hidden?: THidden) {
    this.isHidden = hidden ?? true;
    return this as Column<TType, null, null>;
  }

  /**
   * Generate default value at runtime in application code (not in the database).
   *
   * Use this when you need values generated in your application code, either because:
   * - Your database doesn't support the operation (e.g., generating CUIDs)
   * - You want consistent behavior across all databases
   * - You need custom generation logic
   *
   * @param value - Either a literal value or builder callback:
   *   - Literal: Any static value of the column type
   *   - `(b) => b.cuid()` - Generate a CUID identifier
   *   - `(b) => b.now()` - Generate current timestamp
   *   - `(b) => ...` - Custom function that returns the default value
   *
   * @example
   * ```ts
   * column("string").defaultTo$((b) => b.cuid())           // Generate CUID at runtime
   * column("timestamp").defaultTo$((b) => b.now())         // Generate timestamp at runtime
   * column("integer").defaultTo$(42)                       // Static literal
   * column("integer").defaultTo$((b) => Math.floor(Math.random() * 100))  // Custom function
   * ```
   */
  defaultTo$(
    value: TypeMap[TType] | ((builder: RuntimeDefaultBuilder) => RuntimeSpecial | TypeMap[TType]),
  ): Column<TType, TIn | null, TOut> {
    if (typeof value === "function") {
      const fn = value as (builder: RuntimeDefaultBuilder) => RuntimeSpecial | TypeMap[TType];
      const result = fn(runtimeDefaultBuilder);
      if (
        typeof result === "object" &&
        result !== null &&
        "tag" in result &&
        result.tag === "special"
      ) {
        this.default = { runtime: result.value };
      } else {
        // Custom function - we need to wrap the callback to call it again later
        this.default = { runtime: () => fn(runtimeDefaultBuilder) as TypeMap[TType] };
      }
    } else {
      // Direct literal value - wrap it in a function for runtime generation
      this.default = { runtime: () => value };
    }
    return this;
  }

  /**
   * Set a database-level default value (generated by the database, not application code).
   *
   * The database will generate the default value when inserting rows. If the database
   * doesn't support the operation, Fragno will fall back to generating the value in
   * application code.
   *
   * @param value - Either a literal value or builder callback:
   *   - Literal: Any static value of the column type
   *   - `(b) => b.now()` - Database-generated timestamp
   *
   * @example
   * ```ts
   * // Static defaults
   * column("string").defaultTo("active")
   * column("integer").defaultTo(0)
   * column("boolean").defaultTo(true)
   *
   * // Database-generated timestamp (with fallback)
   * column("timestamp").defaultTo((b) => b.now())
   * ```
   */
  defaultTo(
    value: TypeMap[TType] | ((builder: DefaultBuilder) => DBSpecial | TypeMap[TType]),
  ): Column<TType, TIn | null, TOut> {
    if (typeof value === "function") {
      const fn = value as (builder: DefaultBuilder) => DBSpecial | TypeMap[TType];
      const result = fn(defaultBuilder);
      if (
        typeof result === "object" &&
        result !== null &&
        "tag" in result &&
        result.tag === "special"
      ) {
        this.default = { dbSpecial: result.value };
      } else {
        this.default = { value: result as TypeMap[TType] };
      }
    } else {
      this.default = { value };
    }
    return this;
  }

  /**
   * Generate default value for the column at runtime.
   * Used for both runtime defaults (defaultTo$) and fallback generation for
   * database defaults (defaultTo) when the database doesn't support them.
   */
  generateDefaultValue(): TypeMap[TType] | undefined {
    if (!this.default) {
      return;
    }

    if ("value" in this.default) {
      return this.default.value;
    }

    if ("dbSpecial" in this.default) {
      // Fallback generation for database-level special functions
      if (this.default.dbSpecial === "now") {
        return new Date(Date.now()) as TypeMap[TType];
      }
      return;
    }

    // Runtime defaults (defaultTo$)
    if (this.default.runtime === "cuid") {
      return createId() as TypeMap[TType];
    }
    if (this.default.runtime === "now") {
      return new Date(Date.now()) as TypeMap[TType];
    }

    // Custom function
    return this.default.runtime();
  }

  /**
   * @description This is used for type inference only. Runtime value will be undefined.
   * @internal
   */
  get $in(): TIn {
    return undefined as unknown as TIn;
  }

  /**
   * @description This is used for type inference only. Runtime value will be undefined.
   * @internal
   */
  get $out(): TOut {
    return undefined as unknown as TOut;
  }
}

export class IdColumn<
  TType extends IdColumnType = IdColumnType,
  TIn = unknown,
  TOut = unknown,
> extends Column<TType, TIn, TOut> {
  id = true;

  override defaultTo$(
    value: TypeMap[TType] | ((builder: RuntimeDefaultBuilder) => RuntimeSpecial | TypeMap[TType]),
  ) {
    return super.defaultTo$(value) as IdColumn<TType, TIn | null, TOut>;
  }

  override defaultTo(
    value: TypeMap[TType] | ((builder: DefaultBuilder) => DBSpecial | TypeMap[TType]),
  ) {
    return super.defaultTo(value) as IdColumn<TType, TIn | null, TOut>;
  }
}

/**
 * Internal ID column - used for database-native joins and foreign keys.
 * Hidden from user API by default.
 */
export class InternalIdColumn<TIn = unknown, TOut = unknown> extends Column<"bigint", TIn, TOut> {
  override role = "internal-id" as const;

  constructor() {
    super("bigint");
    this.hidden();
  }
}

/**
 * Version column - used for optimistic concurrency control.
 * Automatically incremented on each update.
 */
export class VersionColumn<TIn = unknown, TOut = unknown> extends Column<"integer", TIn, TOut> {
  override role = "version" as const;

  constructor() {
    super("integer");
    this.defaultTo(0).hidden();
  }
}

export function column<TType extends keyof TypeMap>(
  type: TType,
): Column<TType, TypeMap[TType], TypeMap[TType]> {
  return new Column(type);
}

/**
 * Create a reference column that points to another table's internal ID.
 * This is used for foreign key relationships.
 * Always uses bigint to match the internal ID type.
 */
export function referenceColumn(): Column<
  "bigint",
  string | bigint | FragnoId | FragnoReference,
  FragnoReference
> {
  const col = new Column<"bigint", string | bigint | FragnoId | FragnoReference, FragnoReference>(
    "bigint",
  );
  col.role = "reference";
  return col;
}

/**
 * Create an external ID column (user-facing).
 * This is a CUID string that can be auto-generated or user-provided.
 * Input accepts string | FragnoId | null, output returns FragnoId.
 */
export function idColumn(): IdColumn<"varchar(30)", string | FragnoId | null, FragnoId> {
  const col = new IdColumn<"varchar(30)", string | FragnoId | null, FragnoId>("varchar(30)");
  col.role = "external-id";
  col.defaultTo$((b) => b.cuid());
  return col;
}

/**
 * Create an internal ID column (database-native, hidden from user API).
 * Used for joins and foreign keys.
 * @internal
 */
export function internalIdColumn(): InternalIdColumn<null, bigint> {
  const col = new InternalIdColumn<null, bigint>();
  col.role = "internal-id";
  col.hidden();
  return col;
}

/**
 * Create a version column for optimistic concurrency control.
 * @internal
 */
export function versionColumn(): VersionColumn<null, number> {
  const col = new VersionColumn<null, number>();
  col.role = "version";
  col.hidden();
  return col;
}

/**
 * FragnoId represents a unified ID object that can contain external ID, internal ID, or both.
 * @internal
 *
 * For query inputs: externalId is sufficient (internalId is optional)
 * For query results: both externalId and internalId are provided
 */
export class FragnoId {
  readonly #externalId: string;
  readonly #internalId?: bigint;
  readonly #version: number;

  constructor({
    externalId,
    internalId,
    version,
  }: {
    externalId: string;
    internalId?: bigint;
    version: number;
  }) {
    this.#externalId = externalId;
    this.#internalId = internalId;
    this.#version = version;
  }

  /**
   * Create a FragnoId from just an external ID (for inputs)
   */
  static fromExternal(externalId: string, version: number): FragnoId {
    return new FragnoId({ externalId, version });
  }

  get version(): number {
    return this.#version;
  }

  get externalId(): string {
    return this.#externalId;
  }

  get internalId(): bigint | undefined {
    return this.#internalId;
  }

  /**
   * Get the appropriate ID for database operations
   * Prefers internal ID if available, falls back to external ID
   */
  get databaseId(): string | bigint {
    return this.#internalId ?? this.#externalId;
  }

  /**
   * Convert to a plain object for serialization
   */
  toJSON(): { externalId: string; internalId?: string } {
    return {
      externalId: this.#externalId,
      internalId: this.#internalId?.toString(),
    };
  }

  toString(): string {
    return this.#externalId;
  }

  valueOf(): string {
    return this.#externalId;
  }
}

/**
 * FragnoReference represents a foreign key reference to another table's internal ID.
 * Unlike FragnoId, it only contains the internal ID (bigint) of the referenced record.
 * This is used for reference columns in query results.
 * @internal
 */
export class FragnoReference {
  readonly #internalId: bigint;

  constructor(internalId: bigint) {
    this.#internalId = internalId;
  }

  /**
   * Create a FragnoReference from an internal ID
   */
  static fromInternal(internalId: bigint): FragnoReference {
    return new FragnoReference(internalId);
  }

  /**
   * Get the internal ID for database operations
   */
  get internalId(): bigint {
    return this.#internalId;
  }
}

type RelationType = "one" | "many";

export class TableBuilder<
  TColumns extends Record<string, AnyColumn> = Record<string, AnyColumn>,
  TRelations extends Record<string, AnyRelation> = Record<string, AnyRelation>,
  TIndexes extends Record<string, Index> = Record<string, Index>,
> {
  #name: string;
  #columns: TColumns;
  #relations: TRelations;
  #indexes: TIndexes;
  #ormName: string = "";
  #columnOrder: string[] = [];

  constructor(name: string) {
    this.#name = name;
    this.#columns = {} as TColumns;
    this.#relations = {} as TRelations;
    this.#indexes = {} as TIndexes;
  }

  // For alterTable to set existing state
  setColumns(columns: TColumns): void {
    this.#columns = { ...columns };
  }

  setRelations(relations: TRelations): void {
    this.#relations = { ...relations };
  }

  setIndexes(indexes: TIndexes): void {
    this.#indexes = { ...indexes };
  }

  // For SchemaBuilder to read collected indexes
  getIndexes(): Index[] {
    return Object.values(this.#indexes) as Index[];
  }

  getColumnOrder(): string[] {
    return this.#columnOrder;
  }

  /**
   * Add a column to the table.
   */
  addColumn<TColumnName extends string, TColumn extends AnyColumn>(
    ormName: TColumnName,
    col: TColumn,
  ): TableBuilder<TColumns & Record<TColumnName, TColumn>, TRelations, TIndexes>;

  /**
   * Add a column to the table with simplified syntax.
   */
  addColumn<TColumnName extends string, TType extends keyof TypeMap>(
    ormName: TColumnName,
    type: TType,
  ): TableBuilder<
    TColumns & Record<TColumnName, Column<TType, TypeMap[TType], TypeMap[TType]>>,
    TRelations,
    TIndexes
  >;

  addColumn<TColumnName extends string, TColumn extends AnyColumn, TType extends keyof TypeMap>(
    ormName: TColumnName,
    colOrType: TColumn | TType,
  ): TableBuilder<TColumns & Record<TColumnName, TColumn>, TRelations, TIndexes> {
    // Create the column if a type string was provided
    const col = typeof colOrType === "string" ? column(colOrType) : colOrType;

    // Set column metadata
    col.ormName = ormName;
    col.name = ormName;

    // Add column directly to this builder
    this.#columns[ormName] = col as unknown as TColumns[TColumnName];
    this.#columnOrder.push(ormName);

    return this as unknown as TableBuilder<
      TColumns & Record<TColumnName, TColumn>,
      TRelations,
      TIndexes
    >;
  }

  /**
   * Create an index on the specified columns.
   */
  createIndex<
    TIndexName extends string,
    const TColumnNames extends readonly (string & keyof TColumns)[],
  >(
    name: TIndexName,
    columns: TColumnNames,
    options?: { unique?: boolean },
  ): TableBuilder<
    TColumns,
    TRelations,
    TIndexes & Record<TIndexName, Index<ColumnsToTuple<TColumns, TColumnNames>, TColumnNames>>
  > {
    const cols = columns.map((colName) => {
      const column = this.#columns[colName];
      if (!column) {
        throw new Error(`Unknown column name ${colName}`);
      }
      return column;
    });

    const unique = options?.unique ?? false;
    // Safe: we're adding the index to the internal indexes object
    this.#indexes[name] = {
      name,
      columns: cols,
      columnNames: columns,
      unique,
    } as unknown as TIndexes[TIndexName];

    return this as unknown as TableBuilder<
      TColumns,
      TRelations,
      TIndexes & Record<TIndexName, Index<ColumnsToTuple<TColumns, TColumnNames>, TColumnNames>>
    >;
  }

  /**
   * Build the final table. This should be called after all columns are added.
   */
  build(): Table<TColumns, TRelations, TIndexes> {
    let idCol: AnyColumn | undefined;
    let internalIdCol: AnyColumn | undefined;
    let versionCol: AnyColumn | undefined;

    // TODO: Throw if user manually added version/internalId columns

    // Auto-add _internalId and _version columns if not already present
    if (!this.#columns["_internalId"]) {
      const col = internalIdColumn();
      col.ormName = "_internalId";
      col.name = "_internalId";
      // Safe: we're adding system columns to the internal columns object
      (this.#columns as Record<string, AnyColumn>)["_internalId"] = col;
    }

    if (!this.#columns["_version"]) {
      const col = versionColumn();
      col.ormName = "_version";
      col.name = "_version";
      // Safe: we're adding system columns to the internal columns object
      (this.#columns as Record<string, AnyColumn>)["_version"] = col;
    }

    // Use name as ormName if ormName is not set
    const ormName = this.#ormName || this.#name;

    const table: Table<TColumns, TRelations, TIndexes> = {
      name: this.#name,
      ormName,
      columns: this.#columns,
      relations: this.#relations,
      indexes: this.#indexes,
      getColumnByName: (name) => {
        return Object.values(this.#columns).find((c) => c.name === name);
      },
      getIdColumn: () => {
        return idCol!;
      },
      getInternalIdColumn: () => {
        return internalIdCol!;
      },
      getVersionColumn: () => {
        return versionCol!;
      },
    };

    // Set table reference and find special columns
    for (const k in this.#columns) {
      const column = this.#columns[k];
      if (!column) {
        continue;
      }

      column.tableName = table.name;
      if (column instanceof IdColumn || column.role === "external-id") {
        idCol = column;
      }
      if (column instanceof InternalIdColumn || column.role === "internal-id") {
        internalIdCol = column;
      }
      if (column instanceof VersionColumn || column.role === "version") {
        versionCol = column;
      }
    }

    if (idCol === undefined) {
      throw new Error(`there's no id column in your table ${this.#name}`);
    }
    if (internalIdCol === undefined) {
      throw new Error(`there's no internal id column in your table ${this.#name}`);
    }
    if (versionCol === undefined) {
      throw new Error(`there's no version column in your table ${this.#name}`);
    }

    return table;
  }
}

export interface Schema<TTables extends Record<string, AnyTable> = Record<string, AnyTable>> {
  /**
   * @description The version of the schema, automatically incremented on each change.
   */
  version: number;
  tables: TTables;
  /**
   * @description Operations performed on this schema, in order.
   * Used to generate migrations for specific version ranges.
   */
  operations: SchemaOperation[];

  clone: () => Schema<TTables>;
}

/**
 * Utility type for updating a single table's relations in a schema.
 * Used to properly type the return value of addReference.
 */
type UpdateTableRelations<
  TTables extends Record<string, AnyTable>,
  TTableName extends keyof TTables,
  TReferenceName extends string,
  TReferencedTableName extends keyof TTables,
  TRelationType extends RelationType = RelationType,
> = {
  [K in keyof TTables]: K extends TTableName
    ? Table<
        TTables[TTableName]["columns"],
        TTables[TTableName]["relations"] &
          Record<TReferenceName, Relation<TRelationType, TTables[TReferencedTableName]>>,
        TTables[TTableName]["indexes"]
      >
    : TTables[K];
};

/**
 * Utility type for updating a single table in a schema.
 * Used to properly type the return value of alterTable.
 */
type UpdateTable<
  TTables extends Record<string, AnyTable>,
  TTableName extends keyof TTables,
  TNewColumns extends Record<string, AnyColumn>,
  TNewRelations extends Record<string, AnyRelation>,
  TNewIndexes extends Record<string, Index>,
> = {
  [K in keyof TTables]: K extends TTableName
    ? Table<TNewColumns, TNewRelations, TNewIndexes>
    : TTables[K];
};

/**
 * Map an array of column names to a tuple of their actual column types
 */
type ColumnsToTuple<
  TColumns extends Record<string, AnyColumn>,
  TColumnNames extends readonly (keyof TColumns)[],
> = {
  [K in keyof TColumnNames]: TColumnNames[K] extends keyof TColumns
    ? TColumns[TColumnNames[K]]
    : never;
} & AnyColumn[];

export class SchemaBuilder<TTables extends Record<string, AnyTable> = {}> {
  #tables: TTables;
  #version: number = 0;
  #operations: SchemaOperation[] = [];

  constructor(existingSchema?: Schema<TTables>) {
    if (existingSchema) {
      this.#tables = existingSchema.tables;
      this.#version = existingSchema.version;
      this.#operations = [...existingSchema.operations];
    } else {
      this.#tables = {} as TTables;
    }
  }

  /**
   * Add an existing schema to this builder.
   * Merges tables and operations from the provided schema.
   *
   * @example
   * ```ts
   * const builder = new SchemaBuilder()
   *   .add(userSchema)
   *   .add(postSchema)
   *   .addTable("comments", ...);
   * ```
   */
  mergeWithExistingSchema<TNewTables extends Record<string, AnyTable>>(
    schema: Schema<TNewTables>,
  ): SchemaBuilder<TTables & TNewTables> {
    this.#tables = { ...this.#tables, ...schema.tables } as TTables & TNewTables;
    this.#operations = [...this.#operations, ...schema.operations];
    this.#version += schema.version;

    return this as unknown as SchemaBuilder<TTables & TNewTables>;
  }

  /**
   * Add a table to the schema. Increments the version counter.
   */
  addTable<
    TTableName extends string,
    TColumns extends Record<string, AnyColumn>,
    TRelations extends Record<string, AnyRelation>,
    TIndexes extends Record<string, Index> = Record<string, Index>,
  >(
    ormName: TTableName,
    callback: (
      builder: TableBuilder<
        Record<string, AnyColumn>,
        Record<string, AnyRelation>,
        Record<string, Index>
      >,
    ) => TableBuilder<TColumns, TRelations, TIndexes>,
  ): SchemaBuilder<TTables & Record<TTableName, Table<TColumns, TRelations, TIndexes>>> {
    this.#version++;

    const tableBuilder = new TableBuilder(ormName);
    const result = callback(tableBuilder);
    const builtTable = result.build();
    builtTable.ormName = ormName;

    // Collect sub-operations in order
    const subOperations: TableSubOperation[] = [];

    // Add user-defined columns first
    const columnOrder = result.getColumnOrder();
    for (const colName of columnOrder) {
      const col = builtTable.columns[colName];
      subOperations.push({
        type: "add-column",
        columnName: colName,
        column: col,
      });
    }

    // Add system columns (_internalId and _version) that were auto-added
    if (builtTable.columns["_internalId"]) {
      subOperations.push({
        type: "add-column",
        columnName: "_internalId",
        column: builtTable.columns["_internalId"],
      });
    }
    if (builtTable.columns["_version"]) {
      subOperations.push({
        type: "add-column",
        columnName: "_version",
        column: builtTable.columns["_version"],
      });
    }

    // Add indexes from builder
    for (const idx of result.getIndexes()) {
      subOperations.push({
        type: "add-index",
        name: idx.name,
        columns: idx.columns.map((c) => c.ormName),
        unique: idx.unique,
      });
    }

    // Add the add-table operation
    this.#operations.push({
      type: "add-table",
      tableName: ormName,
      operations: subOperations,
    });

    // Update tables map
    this.#tables = { ...this.#tables, [ormName]: builtTable } as TTables &
      Record<TTableName, Table<TColumns, TRelations, TIndexes>>;

    return this as unknown as SchemaBuilder<
      TTables & Record<TTableName, Table<TColumns, TRelations, TIndexes>>
    >;
  }

  /**
   * Add a relation between two tables.
   *
   * @param referenceName - A name for this relation (e.g., "author", "posts")
   * @param config - Configuration specifying the relation type and foreign key mapping
   *
   * @example
   * ```ts
   * // One-to-one or many-to-one: post -> user
   * schema(s => s
   *   .addTable("users", t => t.addColumn("id", idColumn()))
   *   .addTable("posts", t => t
   *     .addColumn("id", idColumn())
   *     .addColumn("userId", referenceColumn()))
   *   .addReference("author", {
   *     type: "one",
   *     from: { table: "posts", column: "userId" },
   *     to: { table: "users", column: "id" },
   *   })
   * )
   *
   * // One-to-many (inverse relation): user -> posts
   * .addReference("posts", {
   *   type: "many",
   *   from: { table: "users", column: "id" },
   *   to: { table: "posts", column: "userId" },
   * })
   *
   * // Self-referencing foreign key
   * .addReference("inviter", {
   *   type: "one",
   *   from: { table: "users", column: "invitedBy" },
   *   to: { table: "users", column: "id" },
   * })
   * ```
   */
  addReference<
    TFromTableName extends string & keyof TTables,
    TToTableName extends string & keyof TTables,
    TReferenceName extends string,
    TRelationType extends RelationType,
  >(
    referenceName: TReferenceName,
    config: {
      type: TRelationType;
      from: {
        table: TFromTableName;
        column: keyof TTables[TFromTableName]["columns"];
      };
      to: {
        table: TToTableName;
        column: keyof TTables[TToTableName]["columns"];
      };
    },
  ): SchemaBuilder<
    UpdateTableRelations<TTables, TFromTableName, TReferenceName, TToTableName, TRelationType>
  > {
    this.#version++;

    const table = this.#tables[config.from.table];
    const referencedTable = this.#tables[config.to.table];

    if (!table) {
      throw new Error(`Table ${config.from.table} not found in schema`);
    }
    if (!referencedTable) {
      throw new Error(`Referenced table ${config.to.table} not found in schema`);
    }

    const columnName = config.from.column as string;
    const targetColumnName = config.to.column as string;

    // Foreign keys always reference internal IDs, not external IDs
    // If user specifies "id", translate to "_internalId" for the actual FK
    const actualTargetColumnName = targetColumnName === "id" ? "_internalId" : targetColumnName;

    const column = table.columns[columnName];
    const referencedColumn = referencedTable.columns[actualTargetColumnName];

    if (!column) {
      throw new Error(`Column ${columnName} not found in table ${config.from.table}`);
    }
    if (!referencedColumn) {
      throw new Error(`Column ${actualTargetColumnName} not found in table ${config.to.table}`);
    }

    // Verify that reference columns are bigint (matching internal ID type)
    if (column.role === "reference" && column.type !== "bigint") {
      throw new Error(
        `Reference column ${columnName} must be of type bigint to match internal ID type`,
      );
    }

    // Create the relation (use the user-facing column name for the relation)
    const init = new ExplicitRelationInit(config.type, referencedTable, table);
    init.on.push([columnName, targetColumnName]);
    const relation = init.init(referenceName);

    // Add relation to the table
    table.relations[referenceName] = relation;

    // Record the operation
    this.#operations.push({
      type: "add-reference",
      tableName: config.from.table,
      referenceName,
      config: {
        type: config.type,
        from: { table: config.from.table, column: columnName },
        to: { table: config.to.table, column: actualTargetColumnName },
      },
    });

    // Return this with updated type
    // Safe: The relation was added to the table in place and now has the updated relations
    return this as unknown as SchemaBuilder<
      UpdateTableRelations<TTables, TFromTableName, TReferenceName, TToTableName, TRelationType>
    >;
  }

  /**
   * Alter an existing table by adding columns or indexes.
   * This is used for append-only schema modifications.
   *
   * @param tableName - The name of the table to modify
   * @param callback - A callback that receives a table builder for adding columns/indexes
   *
   * @example
   * ```ts
   * // Add a new column to an existing table
   * schema(s => s
   *   .addTable("users", t => t
   *     .addColumn("id", idColumn())
   *     .addColumn("name", column("string")))
   *   .alterTable("users", t => t
   *     .addColumn("email", column("string"))
   *     .addColumn("age", column("integer").nullable())
   *     .createIndex("idx_email", ["email"]))
   * )
   * ```
   */
  alterTable<
    TTableName extends string & keyof TTables,
    TNewColumns extends Record<string, AnyColumn>,
    TNewRelations extends Record<string, AnyRelation>,
    TNewIndexes extends Record<string, Index> = Record<string, Index>,
  >(
    tableName: TTableName,
    callback: (
      builder: TableBuilder<
        TTables[TTableName]["columns"],
        TTables[TTableName]["relations"],
        Record<string, Index>
      >,
    ) => TableBuilder<TNewColumns, TNewRelations, TNewIndexes>,
  ): SchemaBuilder<UpdateTable<TTables, TTableName, TNewColumns, TNewRelations, TNewIndexes>> {
    const table = this.#tables[tableName];

    if (!table) {
      throw new Error(`Table ${tableName} not found in schema`);
    }

    // Create builder with existing table state
    const tableBuilder = new TableBuilder(tableName);
    tableBuilder.setColumns(table.columns);
    tableBuilder.setRelations(table.relations);
    tableBuilder.setIndexes(table.indexes);

    // Track existing columns and indexes
    const existingColumns = new Set(Object.keys(table.columns));
    const existingIndexes = new Set(Object.keys(table.indexes));

    // Apply modifications
    const resultBuilder = callback(
      tableBuilder as TableBuilder<
        TTables[TTableName]["columns"],
        TTables[TTableName]["relations"],
        Record<string, Index>
      >,
    );
    const newTable = resultBuilder.build();

    // Collect sub-operations
    const subOperations: TableSubOperation[] = [];

    // Find new columns (preserve order from builder)
    const columnOrder = resultBuilder.getColumnOrder();
    for (const colName of columnOrder) {
      if (!existingColumns.has(colName)) {
        subOperations.push({
          type: "add-column",
          columnName: colName,
          column: newTable.columns[colName],
        });
      }
    }

    // Add only new indexes
    for (const idx of resultBuilder.getIndexes()) {
      if (!existingIndexes.has(idx.name)) {
        subOperations.push({
          type: "add-index",
          name: idx.name,
          columns: idx.columns.map((c) => c.ormName),
          unique: idx.unique,
        });
      }
    }

    if (subOperations.length > 0) {
      this.#version++;
      this.#operations.push({
        type: "alter-table",
        tableName,
        operations: subOperations,
      });
    }

    // Update table reference in schema
    this.#tables[tableName] = newTable as unknown as TTables[TTableName];

    // Set table name for all columns
    for (const col of Object.values(newTable.columns)) {
      col.tableName = newTable.name;
    }

    return this as unknown as SchemaBuilder<
      UpdateTable<TTables, TTableName, TNewColumns, TNewRelations, TNewIndexes>
    >;
  }

  /**
   * Build the final schema. This should be called after all tables are added.
   */
  build(): Schema<TTables> {
    const operations = this.#operations;
    const version = this.#version;
    const tables = this.#tables;

    const schema: Schema<TTables> = {
      version,
      tables,
      operations,
      clone: () => {
        const cloneTables: Record<string, AnyTable> = {};

        for (const [k, v] of Object.entries(tables)) {
          // Create a new table with cloned columns
          const clonedColumns: Record<string, AnyColumn> = {};
          for (const [colName, col] of Object.entries(v.columns)) {
            // Create a new column with the same properties, preserving the column type
            let clonedCol: AnyColumn;
            if (col instanceof InternalIdColumn) {
              clonedCol = new InternalIdColumn();
            } else if (col instanceof VersionColumn) {
              clonedCol = new VersionColumn();
            } else if (col instanceof IdColumn) {
              clonedCol = new IdColumn(col.type);
            } else {
              clonedCol = new Column(col.type);
            }

            clonedCol.name = col.name;
            clonedCol.ormName = col.ormName;
            clonedCol.isNullable = col.isNullable;
            clonedCol.role = col.role;
            clonedCol.isHidden = col.isHidden;
            clonedCol.default = col.default;
            clonedCol.tableName = col.tableName;
            clonedColumns[colName] = clonedCol;
          }

          cloneTables[k] = {
            ...v,
            columns: clonedColumns,
          };
        }

        return new SchemaBuilder<TTables>({
          version,
          tables: cloneTables as TTables,
          operations: [...operations],
          clone: () => {
            throw new Error("Cannot clone during clone");
          },
        }).build();
      },
    };

    return schema;
  }

  /**
   * Get the current version of the schema builder.
   */
  getVersion(): number {
    return this.#version;
  }
}

/**
 * Create a new schema with callback pattern.
 */
export function schema<const TTables extends Record<string, AnyTable> = {}>(
  callback: (builder: SchemaBuilder<{}>) => SchemaBuilder<TTables>,
): Schema<TTables> {
  return callback(new SchemaBuilder()).build();
}

export function compileForeignKey(key: ForeignKey, nameType: "sql" | "orm" = "orm") {
  return {
    name: key.name,
    table: nameType === "sql" ? key.table.name : key.table.ormName,
    referencedTable: nameType === "sql" ? key.referencedTable.name : key.referencedTable.ormName,
    referencedColumns: key.referencedColumns.map((col) =>
      nameType === "sql" ? col.name : col.ormName,
    ),
    columns: key.columns.map((col) => (nameType === "sql" ? col.name : col.ormName)),
  };
}
