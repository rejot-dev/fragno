import type { AnySchema } from "@fragno-dev/db/schema";

import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  createCollection,
  type Collection,
  type CollectionConfig,
  type InferSchemaInput,
  type UtilsRecord,
} from "@tanstack/db";
import {
  persistedCollectionOptions,
  type PersistedCollectionPersistence,
} from "@tanstack/db-sqlite-persistence-core";

import {
  fragnoCollectionOptions,
  type FragnoCollectionOptions,
  type FragnoCollectionUtils,
} from "./collection-options";
import type { FragnoCollectionRow } from "./protocol";

type FragnoTableName<TSchema extends AnySchema> = keyof TSchema["tables"] & string;

type FragnoCollectionInput<TRow extends object, TStandardSchema extends StandardSchemaV1> = [
  TStandardSchema,
] extends [never]
  ? TRow
  : InferSchemaInput<TStandardSchema>;

export type PersistedFragnoCollectionFactoryOptions = {
  persistence: PersistedCollectionPersistence;
  schemaVersion?: number;
};

export function createPersistedFragnoCollectionFactory(
  factoryOptions: PersistedFragnoCollectionFactoryOptions,
) {
  return function createPersistedFragnoCollection<
    TSchema extends AnySchema,
    TTableName extends FragnoTableName<TSchema>,
    TStandardSchema extends StandardSchemaV1 = never,
    TUtils extends UtilsRecord = UtilsRecord,
  >(
    options: FragnoCollectionOptions<TSchema, TTableName, TStandardSchema, TUtils>,
  ): Collection<
    FragnoCollectionRow<TSchema["tables"][TTableName]>,
    string,
    TUtils & FragnoCollectionUtils,
    TStandardSchema,
    FragnoCollectionInput<FragnoCollectionRow<TSchema["tables"][TTableName]>, TStandardSchema>
  > {
    type Row = FragnoCollectionRow<TSchema["tables"][TTableName]>;
    type CollectionUtils = TUtils & FragnoCollectionUtils;

    const sourceOptions = fragnoCollectionOptions(options);
    const persistedOptions = persistedCollectionOptions<
      Row,
      string,
      TStandardSchema,
      CollectionUtils
    >({
      ...sourceOptions,
      persistence: factoryOptions.persistence,
      schemaVersion: factoryOptions.schemaVersion,
    });

    // TanStack's persistence overload widens a generic Standard Schema. The runtime options still
    // preserve the source schema, row, and utility contracts, so establish them once at this
    // adapter boundary instead of requiring every application to repeat the cast.
    const collectionOptions = persistedOptions as unknown as CollectionConfig<
      Row,
      string,
      never,
      CollectionUtils
    >;

    return createCollection(collectionOptions) as Collection<
      Row,
      string,
      CollectionUtils,
      TStandardSchema,
      FragnoCollectionInput<Row, TStandardSchema>
    >;
  };
}
