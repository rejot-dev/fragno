import { resolveDatabaseNamespace } from "@fragno-dev/db/database-namespace";
import type { AnySchema } from "@fragno-dev/db/schema";

import type { Collection } from "@tanstack/db";
import type { PersistedCollectionPersistence } from "@tanstack/db-sqlite-persistence-core";

import type {
  FragnoCollectionOptions,
  FragnoCollectionRow,
  FragnoOutboxCoordinatorState,
} from "../coordinator";
import { fragnoOutboxTargetKey, type FragnoOutboxSynchronizer } from "./fragno-outbox-synchronizer";
import { FragnoTableCollection } from "./fragno-table-collection";

/** Owns the table collections registered against one Fragno outbox coordinator. */
export class FragnoCollectionRegistry<TSchemas extends readonly AnySchema[]> {
  readonly #schemas: Set<AnySchema>;
  readonly #persistence: PersistedCollectionPersistence;
  readonly #schemaVersion: number;
  readonly #outbox: FragnoOutboxSynchronizer;
  readonly #registrations = new Map<string, FragnoTableCollection>();

  constructor(options: {
    schemas: TSchemas;
    persistence: PersistedCollectionPersistence;
    schemaVersion: number;
    outbox: FragnoOutboxSynchronizer;
  }) {
    this.#schemas = validateSchemas(options.schemas);
    this.#persistence = options.persistence;
    this.#schemaVersion = options.schemaVersion;
    this.#outbox = options.outbox;
  }

  registerCollection<
    TSchema extends TSchemas[number],
    TTableName extends keyof TSchema["tables"] & string,
  >(
    schema: TSchema,
    tableName: TTableName,
    coordinatorState: FragnoOutboxCoordinatorState,
    collectionOptions: FragnoCollectionOptions = {},
  ): Collection<FragnoCollectionRow<TSchema["tables"][TTableName]>, string> {
    if (!this.#schemas.has(schema)) {
      throw new Error(`Schema ${schema.name} was not supplied to this Fragno coordinator.`);
    }

    const table = schema.tables[tableName];
    if (!table) {
      throw new Error(`Table ${schema.name}.${tableName} does not exist.`);
    }

    const namespace = resolveDatabaseNamespace(schema.name) ?? "";
    const targetKey = fragnoOutboxTargetKey(namespace, tableName);
    const existing = this.#registrations.get(targetKey);
    if (existing) {
      return existing.collection as unknown as Collection<
        FragnoCollectionRow<TSchema["tables"][TTableName]>,
        string
      >;
    }

    if (coordinatorState !== "idle") {
      throw new Error(
        `Fragno collection ${schema.name}.${tableName} cannot be registered while the coordinator is ${coordinatorState}.`,
      );
    }

    const tableCollection = new FragnoTableCollection({
      id: fragnoTableCollectionId(namespace, tableName),
      idColumnName: table.getIdColumn().name,
      persistence: this.#persistence,
      schemaVersion: this.#schemaVersion,
      outbox: this.#outbox,
      rowUpdateMode: collectionOptions.rowUpdateMode ?? "partial",
      skipMissingTruncateDeletes: collectionOptions.skipMissingTruncateDeletes ?? false,
      target: {
        key: targetKey,
        namespace,
        schema,
        tableName,
      },
    });
    this.#registrations.set(targetKey, tableCollection);

    return tableCollection.collection as unknown as Collection<
      FragnoCollectionRow<TSchema["tables"][TTableName]>,
      string
    >;
  }

  registeredTargets(): readonly string[] {
    return [...this.#registrations.keys()].sort();
  }

  preload(): Promise<void> {
    if (this.#registrations.size === 0) {
      return Promise.reject(
        new Error("At least one Fragno collection must be registered before preload()."),
      );
    }

    return Promise.all(
      [...this.#registrations.values()].map(({ collection }) => collection.preload()),
    ).then(() => {});
  }

  async cleanup(): Promise<void> {
    await Promise.all(
      [...this.#registrations.values()].map(({ collection }) => collection.cleanup()),
    );
  }
}

function validateSchemas(schemas: readonly AnySchema[]): Set<AnySchema> {
  if (schemas.length === 0) {
    throw new Error("createFragnoOutboxCoordinator requires at least one schema.");
  }

  const suppliedSchemas = new Set<AnySchema>();
  const schemaNames = new Set<string>();
  const physicalTargets = new Map<string, { schemaName: string; tableName: string }>();

  for (const schema of schemas) {
    if (suppliedSchemas.has(schema)) {
      throw new Error(`Duplicate Fragno schema ${schema.name}.`);
    }
    if (schemaNames.has(schema.name)) {
      throw new Error(`Duplicate Fragno schema name ${schema.name}.`);
    }
    suppliedSchemas.add(schema);
    schemaNames.add(schema.name);

    const namespace = resolveDatabaseNamespace(schema.name) ?? "";
    for (const tableName of Object.keys(schema.tables)) {
      const targetKey = fragnoOutboxTargetKey(namespace, tableName);
      const existingTarget = physicalTargets.get(targetKey);
      if (existingTarget) {
        throw new Error(
          `Fragno schemas ${existingTarget.schemaName} and ${schema.name} both target ${namespace}.${tableName}.`,
        );
      }
      physicalTargets.set(targetKey, { schemaName: schema.name, tableName });
    }
  }

  return suppliedSchemas;
}

function fragnoTableCollectionId(namespace: string, tableName: string): string {
  return `fragno.outbox.table.v1:${fragnoOutboxTargetKey(namespace, tableName)}`;
}
