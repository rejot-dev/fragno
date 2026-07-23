import type { AnySchema } from "@fragno-dev/db/schema";

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createCollection, type CollectionConfig, type UtilsRecord } from "@tanstack/db";
import {
  persistedCollectionOptions,
  type PersistedCollectionPersistence,
} from "@tanstack/db-sqlite-persistence-core";

import {
  fragnoCollectionOptions,
  type FragnoCollection,
  type FragnoCollectionFactory,
  type FragnoCollectionOptions,
  type FragnoCollectionUtils,
  type FragnoTableName,
} from "./collection-options";
import type { FragnoCollectionRow } from "./protocol";

export type PersistedFragnoCollectionFactoryOptions = {
  persistence: PersistedCollectionPersistence;
  schemaVersion?: number;
};

export function createPersistedFragnoCollectionFactory(
  factoryOptions: PersistedFragnoCollectionFactoryOptions,
): FragnoCollectionFactory {
  return function createPersistedFragnoCollection<
    TSchema extends AnySchema,
    TTableName extends FragnoTableName<TSchema>,
    TStandardSchema extends StandardSchemaV1 = never,
    TUtils extends UtilsRecord = UtilsRecord,
  >(
    options: FragnoCollectionOptions<TSchema, TTableName, TStandardSchema, TUtils>,
  ): FragnoCollection<TSchema, TTableName, TStandardSchema, TUtils> {
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

    return createCollection(collectionOptions) as FragnoCollection<
      TSchema,
      TTableName,
      TStandardSchema,
      TUtils
    >;
  };
}
