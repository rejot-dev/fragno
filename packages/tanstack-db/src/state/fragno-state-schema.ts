import type { TableToColumnValues } from "@fragno-dev/db/query";
import type { AnySchema, AnyTable, FragnoId, FragnoReference } from "@fragno-dev/db/schema";
import { createFragnoStateEventType } from "@fragno-dev/db/state-protocol";

import {
  createStateSchema,
  type CollectionDefinition,
  type CollectionWithHelpers,
} from "@durable-streams/state";
import type { StandardSchemaV1 } from "@standard-schema/spec";

type MaterializedColumnValue<TValue> = TValue extends FragnoId | FragnoReference ? string : TValue;

type MaterializedOutputValues<TTable extends AnyTable> = {
  [TColumnName in keyof TableToColumnValues<TTable>]: MaterializedColumnValue<
    TableToColumnValues<TTable>[TColumnName]
  >;
};

export type FragnoStreamRow<TTable extends AnyTable> = MaterializedOutputValues<TTable>;

export type FragnoStateCollectionInput<
  TSchema extends AnySchema = AnySchema,
  TTableName extends keyof TSchema["tables"] & string = keyof TSchema["tables"] & string,
> = {
  schema: TSchema;
  table: TTableName;
  /** Physical database namespace. Defaults to the logical schema name. */
  namespace?: string | null;
};

export type FragnoStateSchemaInput = Record<string, FragnoStateCollectionInput>;

type TableFromInput<TInput extends FragnoStateCollectionInput> =
  TInput["schema"]["tables"][TInput["table"]];

export type FragnoStateCollectionDefinition<
  TInput extends FragnoStateCollectionInput = FragnoStateCollectionInput,
> = CollectionDefinition<FragnoStreamRow<TableFromInput<TInput>>> & {
  readonly fragno: {
    readonly schema: TInput["schema"];
    readonly table: TableFromInput<TInput>;
    readonly namespace: string | null;
  };
};

type FragnoStateDefinitions<TInput extends FragnoStateSchemaInput> = {
  [TName in keyof TInput]: FragnoStateCollectionDefinition<TInput[TName]>;
};

export type FragnoStateSchema<TInput extends FragnoStateSchemaInput = FragnoStateSchemaInput> = {
  [TName in keyof TInput]: FragnoStateCollectionDefinition<TInput[TName]> &
    CollectionWithHelpers<FragnoStreamRow<TableFromInput<TInput[TName]>>>;
};

export type AnyFragnoStateCollection = {
  readonly type: string;
  readonly primaryKey: string;
  readonly fragno: {
    readonly schema: AnySchema;
    readonly table: AnyTable;
    readonly namespace: string | null;
  };
};

export type AnyFragnoStateSchema = Record<string, AnyFragnoStateCollection>;

export type FragnoStateSchemaCollections<TState extends AnyFragnoStateSchema> = {
  [TName in keyof TState]: TState[TName] extends CollectionDefinition<infer TRow> ? TRow : never;
};

export const normalizeFragnoStateNamespace = (input: FragnoStateCollectionInput): string | null =>
  input.namespace === undefined ? input.schema.name : input.namespace;

const rowSchemaForTable = <TTable extends AnyTable>(
  table: TTable,
): StandardSchemaV1<FragnoStreamRow<TTable>, FragnoStreamRow<TTable>> =>
  ({ "~standard": table["~standard"] }) as StandardSchemaV1<
    FragnoStreamRow<TTable>,
    FragnoStreamRow<TTable>
  >;

/**
 * Define the public collection names and physical Fragno tables represented by one state stream.
 *
 * The returned object is an upstream StateSchema with additional `fragno` ownership metadata. This
 * keeps event types, primary keys, and producer helpers compatible with `@durable-streams/state`.
 */
export function createFragnoStateSchema<const TInput extends FragnoStateSchemaInput>(
  input: TInput,
): FragnoStateSchema<TInput> {
  if (Object.keys(input).length === 0) {
    throw new Error("createFragnoStateSchema requires at least one collection.");
  }

  const definitions = Object.fromEntries(
    Object.entries(input).map(([collectionName, collection]) => {
      const table = collection.schema.tables[collection.table];
      if (!table) {
        throw new Error(
          `Unknown Fragno state table ${collection.schema.name}.${collection.table} for collection ${collectionName}.`,
        );
      }

      const namespace = normalizeFragnoStateNamespace(collection);
      return [
        collectionName,
        {
          schema: rowSchemaForTable(table),
          type: createFragnoStateEventType({
            schemaName: collection.schema.name,
            namespace,
            tableName: table.name,
          }),
          primaryKey: table.getIdColumn().name,
          fragno: {
            schema: collection.schema,
            table,
            namespace,
          },
        },
      ];
    }),
  ) as FragnoStateDefinitions<TInput>;

  return createStateSchema(definitions) as unknown as FragnoStateSchema<TInput>;
}

export function createFragnoStateFingerprint(state: AnyFragnoStateSchema): string {
  const collections = Object.entries(state)
    .map(([collectionName, definition]) => ({
      collectionName,
      eventType: definition.type,
      schemaName: definition.fragno.schema.name,
      namespace: definition.fragno.namespace,
      tableName: definition.fragno.table.name,
    }))
    .sort((left, right) => left.collectionName.localeCompare(right.collectionName));

  return JSON.stringify(collections);
}
