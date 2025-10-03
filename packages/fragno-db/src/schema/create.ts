import { createId } from "../cuid";

export type AnySchema = Schema<Record<string, AnyTable>>;

export type AnyRelation = Relation;

export type AnyTable = Table;

export type AnyColumn =
  | Column<keyof TypeMap, unknown, unknown>
  | IdColumn<IdColumnType, unknown, unknown>;

/**
 * Operations that can be performed on a table during its definition.
 */
export type TableOperation = {
  type: "add-index";
  name: string;
  columns: string[];
  unique: boolean;
};

/**
 * Operations that can be performed on a schema during its definition.
 * These are tracked so we can generate migrations for specific version ranges.
 */
export type SchemaOperation =
  | {
      type: "add-table";
      tableName: string;
      table: AnyTable;
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
    }
  | {
      type: "add-index";
      tableName: string;
      name: string;
      columns: string[];
      unique: boolean;
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

/**
 * Helper function to add an index to a table's index array
 */
function addIndexToTable(
  indexes: Index[],
  name: string,
  columns: AnyColumn[],
  unique: boolean,
): void {
  indexes.push({
    name,
    columns,
    unique,
  });
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
      foreignKey: this.initForeignKey(ormName),
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
  foreignKey: ForeignKey;
}

export interface Table<
  TColumns extends Record<string, AnyColumn> = Record<string, AnyColumn>,
  TRelations extends Record<string, AnyRelation> = Record<string, AnyRelation>,
> {
  name: string;
  ormName: string;

  columns: TColumns;
  relations: TRelations;
  foreignKeys: ForeignKey[];
  indexes: Index[];

  /**
   * Get column by name
   */
  getColumnByName: (name: string) => AnyColumn | undefined;
  getIdColumn: () => AnyColumn;

  clone: () => Table<TColumns, TRelations>;
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
  isUnique: boolean = false;
  isReference: boolean = false;
  default?:
    | { value: TypeMap[TType] }
    | {
        runtime: DefaultFunction<TType>;
      };

  table: AnyTable = undefined as unknown as AnyTable;

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

  clone() {
    const clone = new Column(this.type);
    clone.name = this.name;
    clone.ormName = this.ormName;
    clone.isNullable = this.isNullable;
    clone.isUnique = this.isUnique;
    clone.isReference = this.isReference;
    clone.default = this.default;
    clone.table = this.table;
    return clone;
  }

  getUniqueConstraintName(): string {
    return `unique_c_${this.table.ormName}_${this.ormName}`;
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

  get $in(): TIn {
    throw new Error("Type inference only");
  }
  get $out(): TOut {
    throw new Error("Type inference only");
  }
}

export class IdColumn<
  TType extends IdColumnType = IdColumnType,
  TIn = unknown,
  TOut = unknown,
> extends Column<TType, TIn, TOut> {
  id = true;

  clone() {
    const clone = new IdColumn(this.type);
    clone.name = this.name;
    clone.ormName = this.ormName;
    clone.isNullable = this.isNullable;
    clone.isUnique = this.isUnique;
    clone.isReference = this.isReference;
    clone.default = this.default;
    clone.table = this.table;
    return clone;
  }

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
  col.isReference = true;
  return col as Column<TType, TypeMap[TType], TypeMap[TType]>;
}

export function idColumn(): IdColumn<"varchar(30)", string, string> {
  const col = new IdColumn<"varchar(30)", string, string>("varchar(30)");
  col.defaultTo$("auto");
  return col as IdColumn<"varchar(30)", string, string>;
}

type RelationType = "one";

export class TableBuilder<
  TColumns extends Record<string, AnyColumn> = Record<string, AnyColumn>,
  TRelations extends Record<string, AnyRelation> = Record<string, AnyRelation>,
> {
  #name: string;
  #columns: TColumns;
  #relations: TRelations;
  #foreignKeys: ForeignKey[] = [];
  #indexes: Index[] = [];
  #version: number = 0;
  #ormName: string = "";
  #operations: TableOperation[] = [];

  constructor(name: string) {
    this.#name = name;
    this.#columns = {} as TColumns;
    this.#relations = {} as TRelations;
  }

  /**
   * Add a column to the table. Increments the version counter.
   */
  addColumn<TColumnName extends string, TColumn extends AnyColumn>(
    ormName: TColumnName,
    col: TColumn,
  ): TableBuilder<TColumns & Record<TColumnName, TColumn>, TRelations>;

  /**
   * Add a column to the table with simplified syntax. Increments the version counter.
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
    this.#version++;

    // Create the column if a type string was provided
    const col = typeof colOrType === "string" ? column(colOrType) : colOrType;

    // Create a new instance to ensure immutability semantics
    const builder = new TableBuilder<TColumns & Record<TColumnName, TColumn>, TRelations>(
      this.#name,
    );
    builder.#columns = { ...this.#columns, [ormName]: col } as TColumns &
      Record<TColumnName, TColumn>;
    builder.#relations = this.#relations;
    builder.#foreignKeys = this.#foreignKeys;
    builder.#indexes = this.#indexes;
    builder.#version = this.#version;
    builder.#ormName = this.#ormName;
    builder.#operations = this.#operations;

    // Set column metadata
    col.ormName = ormName;
    col.name = ormName;

    return builder;
  }

  /**
   * Create an index on the specified columns. Increments the version counter.
   */
  createIndex<TColumnName extends string & keyof TColumns>(
    name: string,
    columns: TColumnName[],
    options?: { unique?: boolean },
  ): TableBuilder<TColumns, TRelations> {
    this.#version++;

    const cols = columns.map((name) => {
      const column = this.#columns[name];
      if (!column) {
        throw new Error(`Unknown column name ${name}`);
      }
      return column;
    });

    const unique = options?.unique ?? false;
    addIndexToTable(this.#indexes, name, cols, unique);

    // Record the operation
    this.#operations.push({
      type: "add-index",
      name,
      columns: columns as string[],
      unique,
    });

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
      foreignKeys: this.#foreignKeys,
      indexes: this.#indexes,
      getColumnByName: (name) => {
        return Object.values(this.#columns).find((c) => c.name === name);
      },
      getIdColumn: () => {
        return idCol!;
      },
      clone: () => {
        const cloneColumns: Record<string, AnyColumn> = {};

        for (const [k, v] of Object.entries(this.#columns)) {
          cloneColumns[k] = v.clone();
        }

        const builder = new TableBuilder<TColumns, TRelations>(this.#name);
        builder.#columns = cloneColumns as TColumns;
        builder.#relations = this.#relations;
        builder.#foreignKeys = [...this.#foreignKeys];
        builder.#indexes = [...this.#indexes];
        builder.#version = this.#version;
        builder.#ormName = this.#ormName;
        builder.#operations = [...this.#operations];

        const cloned = builder.build();

        return cloned;
      },
    };

    // Set table reference and find id column
    for (const k in this.#columns) {
      const column = this.#columns[k];
      if (!column) {
        continue;
      }

      column.table = table;
      if (column instanceof IdColumn) {
        idCol = column;
      }
    }

    if (idCol === undefined) {
      throw new Error(`there's no id column in your table ${this.#name}`);
    }

    return table;
  }

  /**
   * Get the current version of the table builder.
   */
  getVersion(): number {
    return this.#version;
  }

  /**
   * Get the operations performed on this table.
   */
  getOperations(): TableOperation[] {
    return this.#operations;
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

    // Set table metadata
    builtTable.ormName = ormName;

    const builder = new SchemaBuilder<TTables & Record<TTableName, Table<TColumns, TRelations>>>();
    builder.#tables = { ...this.#tables, [ormName]: builtTable } as TTables &
      Record<TTableName, Table<TColumns, TRelations>>;

    // Start with existing operations plus the add-table operation
    const newOperations: SchemaOperation[] = [
      ...this.#operations,
      {
        type: "add-table",
        tableName: ormName,
        table: builtTable,
      },
    ];

    // Promote table operations to schema operations and increment version for each
    const tableOps = result.getOperations();
    for (const tableOp of tableOps) {
      if (tableOp.type === "add-index") {
        this.#version++;
        newOperations.push({
          type: "add-index",
          tableName: ormName,
          name: tableOp.name,
          columns: tableOp.columns,
          unique: tableOp.unique,
        });
      }
    }

    builder.#version = this.#version;
    builder.#operations = newOperations;

    return builder;
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
  >(
    tableName: TTableName,
    referenceName: string,
    config: {
      columns: (keyof TTables[TTableName]["columns"])[];
      targetTable: TReferencedTableName;
      targetColumns: (keyof TTables[TReferencedTableName]["columns"])[];
    },
  ): SchemaBuilder<TTables> {
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

    // Add relation and foreign key to the table
    table.relations[referenceName] = relation;
    table.foreignKeys.push(relation.foreignKey);

    // Record the operation
    this.#operations.push({
      type: "add-reference",
      tableName: tableName as string,
      referenceName,
      config: {
        columns: columns as string[],
        targetTable: config.targetTable as string,
        targetColumns: targetColumns as string[],
      },
    });

    return this;
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
          cloneTables[k] = v.clone();
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
export function schema<TTables extends Record<string, AnyTable> = Record<string, never>>(
  callback: (builder: SchemaBuilder<Record<string, never>>) => SchemaBuilder<TTables>,
): Schema<TTables> {
  return callback(new SchemaBuilder()).build();
}

export function compileForeignKey(key: ForeignKey) {
  return {
    name: key.name,
    table: key.table.name,
    referencedTable: key.referencedTable.name,
    referencedColumns: key.referencedColumns.map((col) => col.name),
    columns: key.columns.map((col) => col.name),
  };
}
