import type {
  AnyColumn,
  AnySchema,
  AnyTable,
  FragnoReference,
  FragnoReferenceTo,
} from "@fragno-dev/db/schema";

import type { ValueType } from "./vendor/zero-types/src/schema-value.ts";
import type { Relationship, TableSchema } from "./vendor/zero-types/src/schema.ts";

type ColumnOut<TColumn> = TColumn extends { $out: infer TOut } ? TOut : never;

/**
 * The value IVM holds for a column: the replica's SQLite value, with booleans and JSON decoded.
 * Dates and timestamps are epoch milliseconds, and a reference is the referenced row's
 * `_internalId`.
 */
type ZqlColumnValue<TColumn extends AnyColumn> = TColumn extends { id: true }
  ? string
  : NonNullable<ColumnOut<TColumn>> extends FragnoReference
    ? number
    : TColumn["type"] extends "bool"
      ? boolean
      : TColumn["type"] extends "json"
        ? NonNullable<ColumnOut<TColumn>>
        : TColumn["type"] extends "string" | "text" | `varchar(${number})`
          ? string
          : number;

type ZqlColumnSchema<TColumn extends AnyColumn> = {
  readonly type: ValueType;
  readonly optional: null extends ColumnOut<TColumn> ? true : false;
  readonly customType: ZqlColumnValue<TColumn>;
};

type SystemColumnSchema = { readonly type: "number"; readonly optional: false; customType: number };

/** IVM reads no blobs, so binary columns are left out. */
type ZqlColumns<TTable extends AnyTable> = {
  readonly [K in keyof TTable["columns"] & string as TTable["columns"][K]["type"] extends "binary"
    ? never
    : K]: ZqlColumnSchema<TTable["columns"][K]>;
} & {
  readonly _internalId: SystemColumnSchema;
  readonly _version: SystemColumnSchema;
};

type ReferencedTable<TColumn> =
  NonNullable<ColumnOut<TColumn>> extends FragnoReferenceTo<infer TTable extends string>
    ? TTable
    : never;

/** Fragno names a reference column's forward relation after the column, without `Id` or `_id`. */
type ForwardRelationName<TColumn extends string> = TColumn extends `${infer TBase}Id`
  ? TBase extends ""
    ? TColumn
    : TBase
  : TColumn extends `${infer TBase}_id`
    ? TBase extends ""
      ? TColumn
      : TBase
    : TColumn;

/** A relationship to the referenced row per reference column. */
type ZqlRelationships<TTable extends AnyTable> = {
  readonly [K in keyof TTable["columns"] & string as [
    ReferencedTable<TTable["columns"][K]>,
  ] extends [never]
    ? never
    : ForwardRelationName<K>]: readonly [
    {
      readonly sourceField: readonly [K];
      readonly destField: readonly ["_internalId"];
      readonly destSchema: ReferencedTable<TTable["columns"][K]>;
      readonly cardinality: "one";
    },
  ];
};

/**
 * The ZQL schema of a Fragno schema's replica tables. Each table is named and keyed like in
 * Fragno, by its external `id`.
 */
export type LofiZqlSchema<TSchema extends AnySchema> = {
  readonly tables: {
    readonly [K in keyof TSchema["tables"] & string]: {
      readonly name: K;
      readonly columns: ZqlColumns<TSchema["tables"][K]>;
      readonly primaryKey: readonly [string];
    };
  };
  readonly relationships: {
    readonly [K in keyof TSchema["tables"] & string]: ZqlRelationships<TSchema["tables"][K]>;
  };
};

/**
 * Describes a Fragno schema's replica tables to ZQL. A reference column `authorId` gives its table
 * a relationship named like Fragno's forward relation, `author`, to the referenced row.
 */
export function lofiZqlSchema<const TSchema extends AnySchema>(
  schema: TSchema,
): LofiZqlSchema<TSchema> {
  const tables: Record<string, TableSchema> = {};
  const relationships: Record<string, Record<string, Relationship>> = {};
  for (const table of Object.values(schema.tables)) {
    tables[table.name] = {
      name: table.name,
      columns: Object.fromEntries(
        Object.values(table.columns).flatMap((column) => {
          const type = zqlValueType(column);
          return type === null ? [] : [[column.name, { type, optional: column.isNullable }]];
        }),
      ),
      primaryKey: [table.getIdColumn().name],
    };
    relationships[table.name] = Object.fromEntries(
      Object.values(table.relations).map((relation) => [
        relation.name,
        [
          {
            sourceField: relation.on.map(([column]) => column),
            destField: [relation.table.getInternalIdColumn().name],
            destSchema: relation.table.name,
            cardinality: "one",
          },
        ],
      ]),
    );
  }
  return { tables, relationships } as unknown as LofiZqlSchema<TSchema>;
}

function zqlValueType(column: AnyColumn): ValueType | null {
  if (column.role === "external-id") {
    return "string";
  }
  switch (column.type) {
    case "bool":
      return "boolean";
    case "json":
      return "json";
    case "string":
    case "text":
      return "string";
    case "integer":
    case "bigint":
    case "decimal":
    case "date":
    case "timestamp":
      return "number";
    case "binary":
      // IVM reads no blobs.
      return null;
    default:
      // varchar(n)
      return "string";
  }
}
