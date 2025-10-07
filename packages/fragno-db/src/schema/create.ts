import { createId } from "../cuid";

export type AnySchema = Schema<Record<string, AnyTable>>;

export type AnyRelation = Relation;

export type AnyTable = Table;

export type AnyColumn =
  | Column<keyof TypeMap, unknown, unknown>
  | IdColumn<IdColumnType, unknown, unknown>;
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
      tableName: string;
      referenceName: string;
      config: {
        columns: string[];
        targetTable: string;
        targetColumns: string[];
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

export interface Index {
  name: string;
  columns: AnyColumn[];
  unique: boolean;
}

export class ExplicitRelationInit<
  TRelationType extends RelationType,
  TTables extends Record<string, AnyTable>,
  TTableName extends keyof TTables,
> extends RelationInit<TRelationType, TTables, TTableName> {
  private foreignKeyName?: string;

  private initForeignKey(ormName: string): ForeignKey {
    const columns: AnyColumn[] = [];
    const referencedColumns: AnyColumn[] = [];

    for (const [left, right] of this.on) {
      columns.push(this.referencer.columns[left]);
      referencedColumns.push(this.referencedTable.columns[right]);
    }

    return {
      columns,
      referencedColumns,
      referencedTable: this.referencedTable,
      table: this.referencer,
      name:
        this.foreignKeyName ??
        `${this.referencer.ormName}_${this.referencedTable.ormName}_${ormName}_fk`,
    };
  }

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

  /**
   * Define custom foreign key name.
   */
  foreignKey(name: string) {
    this.foreignKeyName = name;
    return this;
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
> {
  name: string;
  ormName: string;

  columns: TColumns;
  relations: TRelations;

  /**
   * Get column by name
   */
  getColumnByName: (name: string) => AnyColumn | undefined;
  getIdColumn: () => AnyColumn;
}

type DefaultFunctionMap = {
  date: "now";
  timestamp: "now";
  string: "auto";
} & Record<`varchar(${number})`, "auto">;

type DefaultFunction<TType extends keyof TypeMap> =
  | (TType extends keyof DefaultFunctionMap ? DefaultFunctionMap[TType] : never)
  | (() => TypeMap[TType]);

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
  role: "id" | "reference" | "regular" = "regular";
  default?:
    | { value: TypeMap[TType] }
    | {
        runtime: DefaultFunction<TType>;
      };

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

  /**
   * Generate default value on runtime
   */
  defaultTo$(fn: DefaultFunction<TType>): Column<TType, TIn | null, TOut> {
    this.default = { runtime: fn };
    return this;
  }

  /**
   * Set a database-level default value
   *
   * For schemaless database, it's still generated on runtime
   */
  defaultTo(value: TypeMap[TType]): Column<TType, TIn | null, TOut> {
    this.default = { value };
    return this;
  }

  /**
   * Generate default value for the column on runtime.
   */
  generateDefaultValue(): TypeMap[TType] | undefined {
    if (!this.default) {
      return;
    }

    if ("value" in this.default) {
      return this.default.value;
    }
    if (this.default.runtime === "auto") {
      return createId() as TypeMap[TType];
    }
    if (this.default.runtime === "now") {
      return new Date(Date.now()) as TypeMap[TType];
    }

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

  override defaultTo$(fn: DefaultFunction<TType>) {
    return super.defaultTo$(fn) as IdColumn<TType, TIn | null, TOut>;
  }

  override defaultTo(value: TypeMap[TType]) {
    return super.defaultTo(value) as IdColumn<TType, TIn | null, TOut>;
  }
}

export function column<TType extends keyof TypeMap>(
  type: TType,
): Column<TType, TypeMap[TType], TypeMap[TType]> {
  return new Column(type);
}

/**
 * Create a reference column that points to another table.
 * This is used for foreign key relationships.
 */
export function referenceColumn<TType extends keyof TypeMap = "varchar(30)">(
  type?: TType,
): Column<TType, TypeMap[TType], TypeMap[TType]> {
  const actualType = (type ?? "varchar(30)") as TType;
  const col = new Column<TType, TypeMap[TType], TypeMap[TType]>(actualType);
  col.role = "reference";
  return col;
}

export function idColumn(): IdColumn<"varchar(30)", string | null, string> {
  const col = new IdColumn<"varchar(30)", string | null, string>("varchar(30)");
  col.role = "id";
  col.defaultTo$("auto");
  return col;
}

type RelationType = "one";

export class TableBuilder<
  TColumns extends Record<string, AnyColumn> = Record<string, AnyColumn>,
  TRelations extends Record<string, AnyRelation> = Record<string, AnyRelation>,
> {
  #name: string;
  #columns: TColumns;
  #relations: TRelations;
  #indexes: Index[] = [];
  #ormName: string = "";
  #columnOrder: string[] = [];

  constructor(name: string) {
    this.#name = name;
    this.#columns = {} as TColumns;
    this.#relations = {} as TRelations;
  }

  // For alterTable to set existing state
  setColumns(columns: TColumns): void {
    this.#columns = { ...columns };
  }

  setRelations(relations: TRelations): void {
    this.#relations = { ...relations };
  }

  // For SchemaBuilder to read collected indexes
  getIndexes(): Index[] {
    return this.#indexes;
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
  ): TableBuilder<TColumns & Record<TColumnName, TColumn>, TRelations>;

  /**
   * Add a column to the table with simplified syntax.
   */
  addColumn<TColumnName extends string, TType extends keyof TypeMap>(
    ormName: TColumnName,
    type: TType,
  ): TableBuilder<
    TColumns & Record<TColumnName, Column<TType, TypeMap[TType], TypeMap[TType]>>,
    TRelations
  >;

  addColumn<TColumnName extends string, TColumn extends AnyColumn, TType extends keyof TypeMap>(
    ormName: TColumnName,
    colOrType: TColumn | TType,
  ): TableBuilder<TColumns & Record<TColumnName, TColumn>, TRelations> {
    // Create the column if a type string was provided
    const col = typeof colOrType === "string" ? column(colOrType) : colOrType;

    // Set column metadata
    col.ormName = ormName;
    col.name = ormName;

    // Add column directly to this builder
    this.#columns[ormName] = col as unknown as TColumns[TColumnName];
    this.#columnOrder.push(ormName);

    return this as unknown as TableBuilder<TColumns & Record<TColumnName, TColumn>, TRelations>;
  }

  /**
   * Create an index on the specified columns.
   */
  createIndex<TColumnName extends string & keyof TColumns>(
    name: string,
    columns: TColumnName[],
    options?: { unique?: boolean },
  ): TableBuilder<TColumns, TRelations> {
    const cols = columns.map((colName) => {
      const column = this.#columns[colName];
      if (!column) {
        throw new Error(`Unknown column name ${colName}`);
      }
      return column;
    });

    const unique = options?.unique ?? false;
    this.#indexes.push({ name, columns: cols, unique });

    return this;
  }

  /**
   * Build the final table. This should be called after all columns are added.
   */
  build(): Table<TColumns, TRelations> {
    let idCol: AnyColumn | undefined;

    // Use name as ormName if ormName is not set
    const ormName = this.#ormName || this.#name;

    const table: Table<TColumns, TRelations> = {
      name: this.#name,
      ormName,
      columns: this.#columns,
      relations: this.#relations,
      getColumnByName: (name) => {
        return Object.values(this.#columns).find((c) => c.name === name);
      },
      getIdColumn: () => {
        return idCol!;
      },
    };

    // Set table reference and find id column
    for (const k in this.#columns) {
      const column = this.#columns[k];
      if (!column) {
        continue;
      }

      column.tableName = table.name;
      if (column instanceof IdColumn) {
        idCol = column;
      }
    }

    if (idCol === undefined) {
      throw new Error(`there's no id column in your table ${this.#name}`);
    }

    return table;
  }
}

/**
 * Create a new table with callback pattern.
 */
export function table<
  TColumns extends Record<string, AnyColumn> = Record<string, AnyColumn>,
  TRelations extends Record<string, AnyRelation> = Record<string, AnyRelation>,
>(
  name: string,
  callback: (
    builder: TableBuilder<Record<string, AnyColumn>, Record<string, AnyRelation>>,
  ) => TableBuilder<TColumns, TRelations>,
): Table<TColumns, TRelations> {
  const builder = new TableBuilder(name);
  const result = callback(builder);
  return result.build();
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
> = {
  [K in keyof TTables]: K extends TTableName
    ? Table<
        TTables[TTableName]["columns"],
        TTables[TTableName]["relations"] &
          Record<TReferenceName, Relation<"one", TTables[TReferencedTableName]>>
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
> = {
  [K in keyof TTables]: K extends TTableName ? Table<TNewColumns, TNewRelations> : TTables[K];
};

export class SchemaBuilder<TTables extends Record<string, AnyTable> = Record<string, never>> {
  #tables: TTables;
  #version: number = 0;
  #operations: SchemaOperation[] = [];

  constructor() {
    this.#tables = {} as TTables;
  }

  /**
   * Add a table to the schema. Increments the version counter.
   */
  addTable<
    TTableName extends string,
    TColumns extends Record<string, AnyColumn>,
    TRelations extends Record<string, AnyRelation>,
  >(
    ormName: TTableName,
    callback: (
      builder: TableBuilder<Record<string, AnyColumn>, Record<string, AnyRelation>>,
    ) => TableBuilder<TColumns, TRelations>,
  ): SchemaBuilder<TTables & Record<TTableName, Table<TColumns, TRelations>>> {
    this.#version++;

    const tableBuilder = new TableBuilder(ormName);
    const result = callback(tableBuilder);
    const builtTable = result.build();
    builtTable.ormName = ormName;

    // Collect sub-operations in order
    const subOperations: TableSubOperation[] = [];

    // Add columns in order
    const columnOrder = result.getColumnOrder();
    for (const colName of columnOrder) {
      const col = builtTable.columns[colName];
      subOperations.push({
        type: "add-column",
        columnName: colName,
        column: col,
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
      Record<TTableName, Table<TColumns, TRelations>>;

    return this as unknown as SchemaBuilder<
      TTables & Record<TTableName, Table<TColumns, TRelations>>
    >;
  }

  /**
   * Add a foreign key reference from this table to another table.
   *
   * @param tableName - The table that has the foreign key column
   * @param referenceName - A name for this reference (e.g., "author", "category")
   * @param config - Configuration specifying the foreign key mapping
   *
   * @example
   * ```ts
   * // Basic foreign key: post -> user
   * schema(s => s
   *   .addTable("users", t => t.addColumn("id", idColumn()))
   *   .addTable("posts", t => t
   *     .addColumn("id", idColumn())
   *     .addColumn("authorId", referenceColumn()))
   *   .addReference("posts", "author", {
   *     columns: ["authorId"],
   *     targetTable: "users",
   *     targetColumns: ["id"],
   *   })
   * )
   *
   * // Self-referencing foreign key
   * .addReference("users", "inviter", {
   *   columns: ["invitedBy"],
   *   targetTable: "users",
   *   targetColumns: ["id"],
   * })
   *
   * // Multiple foreign keys - call addReference multiple times
   * .addReference("posts", "author", {
   *   columns: ["authorId"],
   *   targetTable: "users",
   *   targetColumns: ["id"],
   * })
   * .addReference("posts", "category", {
   *   columns: ["categoryId"],
   *   targetTable: "categories",
   *   targetColumns: ["id"],
   * })
   * ```
   */
  addReference<
    TTableName extends string & keyof TTables,
    TReferencedTableName extends string & keyof TTables,
    TReferenceName extends string,
  >(
    tableName: TTableName,
    referenceName: TReferenceName,
    config: {
      columns: (keyof TTables[TTableName]["columns"])[];
      targetTable: TReferencedTableName;
      targetColumns: (keyof TTables[TReferencedTableName]["columns"])[];
    },
  ): SchemaBuilder<
    UpdateTableRelations<TTables, TTableName, TReferenceName, TReferencedTableName>
  > {
    this.#version++;

    const table = this.#tables[tableName];
    const referencedTable = this.#tables[config.targetTable];

    if (!table) {
      throw new Error(`Table ${tableName} not found in schema`);
    }
    if (!referencedTable) {
      throw new Error(`Referenced table ${config.targetTable} not found in schema`);
    }

    const { columns, targetColumns } = config;

    if (columns.length !== targetColumns.length) {
      throw new Error(
        `Reference ${referenceName}: columns and targetColumns must have the same length`,
      );
    }

    // For now, only support single column foreign keys
    if (columns.length !== 1) {
      throw new Error(
        `Reference ${referenceName}: currently only single column foreign keys are supported`,
      );
    }

    const columnName = columns[0] as string;
    const targetColumnName = targetColumns[0] as string;

    const column = table.columns[columnName];
    const referencedColumn = referencedTable.columns[targetColumnName];

    if (!column) {
      throw new Error(`Column ${columnName} not found in table ${tableName}`);
    }
    if (!referencedColumn) {
      throw new Error(`Column ${targetColumnName} not found in table ${config.targetTable}`);
    }

    // Create the relation
    const init = new ExplicitRelationInit("one", referencedTable, table);
    init.on.push([columnName, targetColumnName]);
    const relation = init.init(referenceName);

    // Add relation to the table
    table.relations[referenceName] = relation;

    // Record the operation
    this.#operations.push({
      type: "add-reference",
      tableName,
      referenceName,
      config: {
        // TODO: Figure out why we need to cast to string[]
        columns: columns as string[],
        targetTable: config.targetTable,
        targetColumns: targetColumns as string[],
      },
    });

    // Return this with updated type
    // Safe: The relation was added to the table in place and now has the updated relations
    return this as unknown as SchemaBuilder<
      UpdateTableRelations<TTables, TTableName, TReferenceName, TReferencedTableName>
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
  >(
    tableName: TTableName,
    callback: (
      builder: TableBuilder<TTables[TTableName]["columns"], TTables[TTableName]["relations"]>,
    ) => TableBuilder<TNewColumns, TNewRelations>,
  ): SchemaBuilder<UpdateTable<TTables, TTableName, TNewColumns, TNewRelations>> {
    const table = this.#tables[tableName];

    if (!table) {
      throw new Error(`Table ${tableName} not found in schema`);
    }

    // Create builder with existing table state
    const tableBuilder = new TableBuilder(tableName);
    tableBuilder.setColumns(table.columns);
    tableBuilder.setRelations(table.relations);

    // Track existing columns
    const existingColumns = new Set(Object.keys(table.columns));

    // Apply modifications
    const resultBuilder = callback(
      tableBuilder as TableBuilder<
        TTables[TTableName]["columns"],
        TTables[TTableName]["relations"]
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

    // Add indexes
    for (const idx of resultBuilder.getIndexes()) {
      subOperations.push({
        type: "add-index",
        name: idx.name,
        columns: idx.columns.map((c) => c.ormName),
        unique: idx.unique,
      });
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
      UpdateTable<TTables, TTableName, TNewColumns, TNewRelations>
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
            // Create a new column with the same properties
            const clonedCol = new Column(col.type);
            clonedCol.name = col.name;
            clonedCol.ormName = col.ormName;
            clonedCol.isNullable = col.isNullable;
            clonedCol.role = col.role;
            clonedCol.default = col.default;
            clonedCol.tableName = col.tableName;
            clonedColumns[colName] = clonedCol;
          }

          cloneTables[k] = {
            ...v,
            columns: clonedColumns,
          };
        }

        const builder = new SchemaBuilder<TTables>();
        builder.#tables = cloneTables as TTables;
        builder.#version = version;
        builder.#operations = [...operations];

        return builder.build();
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
export function schema<const TTables extends Record<string, AnyTable> = Record<string, never>>(
  callback: (builder: SchemaBuilder<Record<string, never>>) => SchemaBuilder<TTables>,
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
