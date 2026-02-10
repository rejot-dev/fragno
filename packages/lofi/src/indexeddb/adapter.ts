import type { AnyColumn, AnySchema, AnyTable } from "@fragno-dev/db/schema";
import { FragnoId, FragnoReference } from "@fragno-dev/db/schema";
import { generateMigrationFromSchema } from "@fragno-dev/db/client";
import { openDB, type IDBPDatabase, type IDBPObjectStore, type IDBPTransaction } from "idb";
import type {
  IndexedDbAdapterOptions,
  LofiAdapter,
  LofiMutation,
  LofiQueryEngineOptions,
  LofiQueryInterface,
  LofiQueryableAdapter,
} from "../types";
import type { ReferenceTarget } from "./types";
import { normalizeValue } from "../query/normalize";
import { createIndexedDbQueryEngine, type IndexedDbQueryContext } from "../query/engine";

type LofiRow = {
  key: [string, string, string, string];
  endpoint: string;
  schema: string;
  table: string;
  id: string;
  data: Record<string, unknown>;
  _lofi: {
    versionstamp: string;
    norm: Record<string, unknown>;
    internalId: number;
    version: number;
  };
};

type InboxRow = {
  key: [string, string];
  sourceKey: string;
  uowId: string;
  versionstamp: string;
  receivedAt: number;
};

type MetaRow = { key: string; value: string };

type LofiDb = IDBPDatabase<unknown>;
type WriteStore<TxStores extends ArrayLike<string>, StoreName extends string> = IDBPObjectStore<
  unknown,
  TxStores,
  StoreName,
  "readwrite"
>;
type UpgradeStore<TxStores extends ArrayLike<string>, StoreName extends string> = IDBPObjectStore<
  unknown,
  TxStores,
  StoreName,
  "versionchange"
>;
type UpgradeTx<TxStores extends ArrayLike<string>> = IDBPTransaction<
  unknown,
  TxStores,
  "versionchange"
>;

type IndexDefinition = {
  name: string;
  table: string;
  schema: string;
  columns: string[];
  unique: boolean;
};

const META_STORE = "lofi_meta";
const ROWS_STORE = "lofi_rows";
const INBOX_STORE = "lofi_inbox";

const INDEX_SCHEMA_TABLE = "idx_schema_table";
const INDEX_INBOX_SOURCE_UOW = "idx_inbox_source_uow";
const LEGACY_INBOX_INDEX = "idx_inbox_source_version";

export class IndexedDbAdapter implements LofiAdapter, LofiQueryableAdapter {
  private readonly dbName: string;
  private readonly endpointName: string;
  private readonly schemas: AnySchema[];
  private readonly schemaMap: Map<string, AnySchema>;
  private readonly tableMap: Map<string, Map<string, AnyTable>>;
  private readonly referenceTargets: Map<string, ReferenceTarget>;
  private readonly schemaFingerprint: string;
  private readonly indexDefinitions: IndexDefinition[];
  private readonly ignoreUnknownSchemas: boolean;

  private dbPromise?: Promise<LofiDb>;

  constructor(options: IndexedDbAdapterOptions) {
    if (!options.endpointName || options.endpointName.trim().length === 0) {
      throw new Error("IndexedDbAdapter requires a non-empty endpointName.");
    }

    const schemaMap = new Map<string, AnySchema>();
    const tableMap = new Map<string, Map<string, AnyTable>>();
    const referenceTargets = new Map<string, ReferenceTarget>();

    for (const registration of options.schemas) {
      const schema = registration.schema;
      if (!schema.name || schema.name.trim().length === 0) {
        throw new Error("IndexedDbAdapter schemas must have a non-empty name.");
      }
      if (schemaMap.has(schema.name)) {
        throw new Error(`IndexedDbAdapter schema name must be unique: ${schema.name}`);
      }

      schemaMap.set(schema.name, schema);
      const tables = new Map<string, AnyTable>();
      for (const [tableName, table] of Object.entries(schema.tables)) {
        tables.set(tableName, table);
        for (const relation of Object.values(table.relations)) {
          for (const [fromColumn] of relation.on) {
            referenceTargets.set(`${schema.name}::${table.name}::${fromColumn}`, {
              schema: schema.name,
              table: relation.table.name,
            });
          }
        }
      }
      tableMap.set(schema.name, tables);
    }

    this.dbName = options.dbName ?? `fragno_lofi_${options.endpointName}`;
    this.endpointName = options.endpointName;
    this.schemas = [...schemaMap.values()];
    this.schemaMap = schemaMap;
    this.tableMap = tableMap;
    this.referenceTargets = referenceTargets;
    this.indexDefinitions = buildIndexDefinitions(this.schemas);
    this.schemaFingerprint = buildSchemaFingerprint(this.schemas, this.indexDefinitions);
    this.ignoreUnknownSchemas = options.ignoreUnknownSchemas ?? false;
  }

  async applyOutboxEntry(options: {
    sourceKey: string;
    versionstamp: string;
    uowId: string;
    mutations: LofiMutation[];
  }): Promise<{ applied: boolean }> {
    const db = await this.openDatabase();

    const knownMutations: Array<{ mutation: LofiMutation; schema: AnySchema; table: AnyTable }> =
      [];
    for (const mutation of options.mutations) {
      const schema = this.schemaMap.get(mutation.schema);
      if (!schema) {
        if (this.ignoreUnknownSchemas) {
          continue;
        }
        throw new Error(`Unknown outbox schema: ${mutation.schema}`);
      }
      const table = this.tableMap.get(mutation.schema)?.get(mutation.table);
      if (!table) {
        if (this.ignoreUnknownSchemas) {
          continue;
        }
        throw new Error(`Unknown outbox table: ${mutation.schema}.${mutation.table}`);
      }
      knownMutations.push({ mutation, schema, table });
    }

    const tx = db.transaction([ROWS_STORE, INBOX_STORE, META_STORE], "readwrite");
    const rowsStore = tx.objectStore(ROWS_STORE);
    const inboxStore = tx.objectStore(INBOX_STORE);
    const metaStore = tx.objectStore(META_STORE);

    const existingInbox = (await inboxStore.get([options.sourceKey, options.uowId])) as
      | InboxRow
      | undefined;
    if (existingInbox) {
      await tx.done;
      return { applied: false };
    }

    try {
      for (const { mutation, schema, table } of knownMutations) {
        await applyMutation({
          mutation,
          schema,
          table,
          endpointName: this.endpointName,
          rowsStore,
          metaStore,
          referenceTargets: this.referenceTargets,
        });
      }

      const inboxRow: InboxRow = {
        key: [options.sourceKey, options.uowId],
        sourceKey: options.sourceKey,
        uowId: options.uowId,
        versionstamp: options.versionstamp,
        receivedAt: Date.now(),
      };
      await inboxStore.put(inboxRow);

      await tx.done;
      return { applied: true };
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // Ignore abort errors; transaction will already be closing.
      }
      try {
        await tx.done;
      } catch {
        // Ignore abort completion errors; original error is more useful.
      }
      throw error;
    }
  }

  async applyMutations(mutations: LofiMutation[]): Promise<void> {
    if (mutations.length === 0) {
      return;
    }

    const db = await this.openDatabase();

    const knownMutations: Array<{ mutation: LofiMutation; schema: AnySchema; table: AnyTable }> =
      [];
    for (const mutation of mutations) {
      const schema = this.schemaMap.get(mutation.schema);
      if (!schema) {
        if (this.ignoreUnknownSchemas) {
          continue;
        }
        throw new Error(`Unknown mutation schema: ${mutation.schema}`);
      }
      const table = this.tableMap.get(mutation.schema)?.get(mutation.table);
      if (!table) {
        if (this.ignoreUnknownSchemas) {
          continue;
        }
        throw new Error(`Unknown mutation table: ${mutation.schema}.${mutation.table}`);
      }
      knownMutations.push({ mutation, schema, table });
    }

    const tx = db.transaction([ROWS_STORE, META_STORE], "readwrite");
    const rowsStore = tx.objectStore(ROWS_STORE);
    const metaStore = tx.objectStore(META_STORE);

    try {
      for (const { mutation, schema, table } of knownMutations) {
        await applyMutation({
          mutation,
          schema,
          table,
          endpointName: this.endpointName,
          rowsStore,
          metaStore,
          referenceTargets: this.referenceTargets,
        });
      }

      await tx.done;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // Ignore abort errors; transaction will already be closing.
      }
      try {
        await tx.done;
      } catch {
        // Ignore abort completion errors; original error is more useful.
      }
      throw error;
    }
  }

  async getMeta(key: string): Promise<string | undefined> {
    const db = await this.openDatabase();
    const tx = db.transaction(META_STORE, "readonly");
    const store = tx.objectStore(META_STORE);
    const row = (await store.get(key)) as MetaRow | undefined;
    await tx.done;
    return row?.value;
  }

  async setMeta(key: string, value: string): Promise<void> {
    const db = await this.openDatabase();
    const tx = db.transaction(META_STORE, "readwrite");
    const store = tx.objectStore(META_STORE);
    await store.put({ key, value });
    await tx.done;
  }

  createQueryEngine<const T extends AnySchema>(
    schema: T,
    options?: LofiQueryEngineOptions,
  ): LofiQueryInterface<T> {
    return createIndexedDbQueryEngine({
      schema,
      endpointName: this.endpointName,
      getDb: () => this.openDatabase(),
      referenceTargets: this.referenceTargets,
      schemaName: options?.schemaName,
    });
  }

  createQueryContext(schemaName: string): IndexedDbQueryContext {
    return {
      endpointName: this.endpointName,
      schemaName,
      getDb: () => this.openDatabase(),
      referenceTargets: this.referenceTargets,
    };
  }

  private openDatabase(): Promise<LofiDb> {
    if (!this.dbPromise) {
      this.dbPromise = this.openDatabaseInternal();
    }
    return this.dbPromise;
  }

  private async openDatabaseInternal(): Promise<LofiDb> {
    const initialDb = await openDatabaseWithUpgrade(this.dbName, undefined, async (db, tx) => {
      ensureStores(db, tx);
      ensureIndexes(tx, this.indexDefinitions);
      await setMetaInTransaction(
        tx,
        schemaFingerprintKey(this.endpointName),
        this.schemaFingerprint,
      );
    });

    const existingFingerprint = await readMetaValue(
      initialDb,
      schemaFingerprintKey(this.endpointName),
    );

    if (existingFingerprint === this.schemaFingerprint) {
      return initialDb;
    }

    const currentVersion = initialDb.version;
    initialDb.close();

    const upgraded = await openDatabaseWithUpgrade(
      this.dbName,
      currentVersion + 1,
      async (db, tx) => {
        ensureStores(db, tx);
        ensureIndexes(tx, this.indexDefinitions);
        await clearEndpointData(tx, this.endpointName);
        await setMetaInTransaction(
          tx,
          schemaFingerprintKey(this.endpointName),
          this.schemaFingerprint,
        );
      },
    );

    return upgraded;
  }
}

const schemaFingerprintKey = (endpointName: string) => `${endpointName}::schema_fingerprint`;
const cursorKeyDefault = (endpointName: string) => `${endpointName}::outbox`;
const seqKey = (endpointName: string, schema: string, table: string) =>
  `${endpointName}::seq::${schema}::${table}`;

const buildIndexDefinitions = (schemas: AnySchema[]): IndexDefinition[] => {
  const definitions: IndexDefinition[] = [];

  for (const schema of schemas) {
    const operations = generateMigrationFromSchema(schema, 0, schema.version);
    for (const op of operations) {
      if (op.type !== "add-index") {
        continue;
      }
      definitions.push({
        name: op.name,
        schema: schema.name,
        table: op.table,
        columns: op.columns,
        unique: op.unique,
      });
    }
  }

  return definitions;
};

const buildSchemaFingerprint = (schemas: AnySchema[], indexes: IndexDefinition[]): string => {
  const payload = {
    inboxKey: "uowId",
    schemas: [...schemas]
      .map((schema) => ({
        name: schema.name,
        version: schema.version,
        tables: Object.keys(schema.tables).sort(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    indexes: [...indexes]
      .map((index) => ({
        schema: index.schema,
        table: index.table,
        name: index.name,
        columns: [...index.columns],
        unique: index.unique,
      }))
      .sort((a, b) =>
        `${a.schema}.${a.table}.${a.name}`.localeCompare(`${b.schema}.${b.table}.${b.name}`),
      ),
  };

  return JSON.stringify(payload);
};

const ensureStores = <TxStores extends ArrayLike<string>>(
  db: LofiDb,
  tx: UpgradeTx<TxStores>,
): void => {
  if (!db.objectStoreNames.contains(META_STORE)) {
    db.createObjectStore(META_STORE, { keyPath: "key" });
  }

  if (!db.objectStoreNames.contains(ROWS_STORE)) {
    const store = db.createObjectStore(ROWS_STORE, { keyPath: "key" });
    store.createIndex(INDEX_SCHEMA_TABLE, ["endpoint", "schema", "table"], { unique: false });
  } else {
    const store = tx.objectStore(ROWS_STORE);
    if (!store.indexNames.contains(INDEX_SCHEMA_TABLE)) {
      store.createIndex(INDEX_SCHEMA_TABLE, ["endpoint", "schema", "table"], { unique: false });
    }
  }

  if (!db.objectStoreNames.contains(INBOX_STORE)) {
    const store = db.createObjectStore(INBOX_STORE, { keyPath: "key" });
    store.createIndex(INDEX_INBOX_SOURCE_UOW, ["sourceKey", "uowId"], {
      unique: true,
    });
  } else {
    const store = tx.objectStore(INBOX_STORE);
    if (store.indexNames.contains(LEGACY_INBOX_INDEX)) {
      store.deleteIndex(LEGACY_INBOX_INDEX);
    }
    if (!store.indexNames.contains(INDEX_INBOX_SOURCE_UOW)) {
      store.createIndex(INDEX_INBOX_SOURCE_UOW, ["sourceKey", "uowId"], {
        unique: true,
      });
    }
  }
};

const ensureIndexes = <TxStores extends ArrayLike<string>>(
  tx: UpgradeTx<TxStores>,
  indexes: IndexDefinition[],
): void => {
  const store = tx.objectStore(ROWS_STORE);

  for (const index of indexes) {
    const name = `idx__${index.schema}__${index.table}__${index.name}`;
    if (store.indexNames.contains(name)) {
      continue;
    }

    const keyPath = [
      "endpoint",
      "schema",
      "table",
      ...index.columns.map((column) => `_lofi.norm.${column}`),
      "id",
    ];

    store.createIndex(name, keyPath, { unique: index.unique });
  }
};

const clearEndpointData = async <TxStores extends ArrayLike<string>>(
  tx: UpgradeTx<TxStores>,
  endpointName: string,
): Promise<void> => {
  const rowsStore = tx.objectStore(ROWS_STORE);
  const inboxStore = tx.objectStore(INBOX_STORE);
  const metaStore = tx.objectStore(META_STORE);

  await deleteRowsForEndpoint(rowsStore, endpointName);
  await deleteWhere(
    inboxStore,
    (row) => isInboxRow(row) && row.sourceKey.startsWith(`${endpointName}::`),
  );
  await deleteWhere(
    metaStore,
    (row) => isMetaRow(row) && row.key === cursorKeyDefault(endpointName),
  );
};

const deleteRowsForEndpoint = async <TxStores extends ArrayLike<string>, StoreName extends string>(
  store: UpgradeStore<TxStores, StoreName>,
  endpointName: string,
): Promise<void> => {
  const index = store.index(INDEX_SCHEMA_TABLE);
  const range = IDBKeyRange.bound([endpointName], [endpointName, "\uffff", "\uffff"]);
  let cursor = await index.openCursor(range);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
};

const deleteWhere = async <TxStores extends ArrayLike<string>, StoreName extends string>(
  store: UpgradeStore<TxStores, StoreName>,
  predicate: (value: unknown) => boolean,
): Promise<void> => {
  let cursor = await store.openCursor();
  while (cursor) {
    if (predicate(cursor.value)) {
      await cursor.delete();
    }
    cursor = await cursor.continue();
  }
};

const isInboxRow = (value: unknown): value is InboxRow =>
  typeof value === "object" &&
  value !== null &&
  "sourceKey" in value &&
  typeof (value as { sourceKey?: unknown }).sourceKey === "string";

const isMetaRow = (value: unknown): value is MetaRow =>
  typeof value === "object" &&
  value !== null &&
  "key" in value &&
  typeof (value as { key?: unknown }).key === "string";

const openDatabaseWithUpgrade = (
  dbName: string,
  version: number | undefined,
  onUpgrade: (db: LofiDb, tx: UpgradeTx<ArrayLike<string>>) => void | Promise<void>,
): Promise<LofiDb> =>
  openDB(dbName, version, {
    upgrade: async (db, _oldVersion, _newVersion, tx) => {
      await onUpgrade(db, tx as UpgradeTx<ArrayLike<string>>);
    },
  }).then((db) => {
    db.onversionchange = () => db.close();
    return db;
  });

const readMetaValue = async (db: LofiDb, key: string): Promise<string | undefined> => {
  if (!db.objectStoreNames.contains(META_STORE)) {
    return undefined;
  }
  const tx = db.transaction(META_STORE, "readonly");
  const store = tx.objectStore(META_STORE);
  const row = (await store.get(key)) as MetaRow | undefined;
  await tx.done;
  return row?.value;
};

const setMetaInTransaction = async <TxStores extends ArrayLike<string>>(
  tx: UpgradeTx<TxStores>,
  key: string,
  value: string,
): Promise<void> => {
  const store = tx.objectStore(META_STORE);
  await store.put({ key, value });
};

const applyMutation = async <
  TxStores extends ArrayLike<string>,
  RowsStoreName extends string,
  MetaStoreName extends string,
>(options: {
  mutation: LofiMutation;
  schema: AnySchema;
  table: AnyTable;
  endpointName: string;
  rowsStore: WriteStore<TxStores, RowsStoreName>;
  metaStore: WriteStore<TxStores, MetaStoreName>;
  referenceTargets: Map<string, ReferenceTarget>;
}): Promise<void> => {
  const { mutation, schema, table, endpointName, rowsStore, metaStore, referenceTargets } = options;

  const key: LofiRow["key"] = [endpointName, schema.name, table.name, mutation.externalId];
  const existing = (await rowsStore.get(key)) as LofiRow | undefined;

  if (mutation.op === "delete") {
    if (existing) {
      await rowsStore.delete(key);
    }
    return;
  }

  const values = mutation.op === "create" ? mutation.values : mutation.set;
  if (!existing && mutation.op === "update") {
    return;
  }

  const data = existing ? { ...existing.data, ...values } : { ...values };

  const internalId = existing
    ? existing._lofi.internalId
    : await allocateInternalId(metaStore, endpointName, schema.name, table.name);

  const version = existing ? existing._lofi.version + (mutation.op === "update" ? 1 : 0) : 1;
  const norm = await buildNormalizedValues({
    schema,
    table,
    data,
    rowId: mutation.externalId,
    internalId,
    version,
    endpointName,
    rowsStore,
    referenceTargets,
  });

  const row: LofiRow = {
    key,
    endpoint: endpointName,
    schema: schema.name,
    table: table.name,
    id: mutation.externalId,
    data,
    _lofi: {
      versionstamp: mutation.versionstamp,
      norm,
      internalId,
      version,
    },
  };

  await rowsStore.put(row);
};

const allocateInternalId = async <TxStores extends ArrayLike<string>, StoreName extends string>(
  metaStore: WriteStore<TxStores, StoreName>,
  endpointName: string,
  schemaName: string,
  tableName: string,
): Promise<number> => {
  const key = seqKey(endpointName, schemaName, tableName);
  const existing = (await metaStore.get(key)) as MetaRow | undefined;
  const next = existing ? Number(existing.value) + 1 : 1;
  if (Number.isNaN(next) || next > Number.MAX_SAFE_INTEGER) {
    throw new Error(
      `IndexedDbAdapter internalId overflow for ${schemaName}.${tableName}: ${existing?.value}`,
    );
  }
  await metaStore.put({ key, value: String(next) });
  return next;
};

const buildNormalizedValues = async <
  TxStores extends ArrayLike<string>,
  StoreName extends string,
>(options: {
  schema: AnySchema;
  table: AnyTable;
  data: Record<string, unknown>;
  rowId: string;
  internalId: number;
  version: number;
  endpointName: string;
  rowsStore: WriteStore<TxStores, StoreName>;
  referenceTargets: Map<string, ReferenceTarget>;
}): Promise<Record<string, unknown>> => {
  const {
    schema,
    table,
    data,
    rowId,
    internalId,
    version,
    endpointName,
    rowsStore,
    referenceTargets,
  } = options;

  const norm: Record<string, unknown> = {};

  for (const [columnName, column] of Object.entries(table.columns)) {
    norm[columnName] = await resolveColumnValue({
      schema,
      table,
      columnName,
      column,
      data,
      rowId,
      internalId,
      version,
      endpointName,
      rowsStore,
      referenceTargets,
    });
  }

  return norm;
};

const resolveColumnValue = async <
  TxStores extends ArrayLike<string>,
  StoreName extends string,
>(options: {
  schema: AnySchema;
  table: AnyTable;
  columnName: string;
  column: AnyColumn;
  data: Record<string, unknown>;
  rowId: string;
  internalId: number;
  version: number;
  endpointName: string;
  rowsStore: WriteStore<TxStores, StoreName>;
  referenceTargets: Map<string, ReferenceTarget>;
}): Promise<unknown> => {
  const {
    schema,
    table,
    columnName,
    column,
    data,
    rowId,
    internalId,
    version,
    endpointName,
    rowsStore,
    referenceTargets,
  } = options;

  if (column.role === "external-id") {
    return rowId;
  }

  if (column.role === "internal-id") {
    return internalId;
  }

  if (column.role === "version") {
    return version;
  }

  if (column.role === "reference") {
    const rawValue = data[columnName];
    if (rawValue == null) {
      return rawValue;
    }

    if (rawValue instanceof FragnoReference) {
      return coerceInternalIdValue(rawValue.internalId, schema, table, columnName);
    }

    if (rawValue instanceof FragnoId) {
      if (rawValue.internalId !== undefined) {
        return coerceInternalIdValue(rawValue.internalId, schema, table, columnName);
      }
      return resolveReferenceExternalId({
        schema,
        table,
        columnName,
        externalId: rawValue.externalId,
        endpointName,
        rowsStore,
        referenceTargets,
      });
    }

    if (typeof rawValue === "number") {
      throw new Error(
        `Expected reference value to be external ID string for ${schema.name}.${table.name}.${columnName}.`,
      );
    }

    if (typeof rawValue === "bigint") {
      return coerceInternalIdValue(rawValue, schema, table, columnName);
    }

    if (typeof rawValue !== "string") {
      throw new Error(
        `Expected reference value to be external ID string for ${schema.name}.${table.name}.${columnName}.`,
      );
    }

    return resolveReferenceExternalId({
      schema,
      table,
      columnName,
      externalId: rawValue,
      endpointName,
      rowsStore,
      referenceTargets,
    });
  }

  const rawValue = data[columnName];
  if (rawValue === undefined) {
    return undefined;
  }
  if (rawValue === null) {
    return null;
  }

  return normalizeValue(rawValue, column);
};

const resolveReferenceExternalId = async <
  TxStores extends ArrayLike<string>,
  StoreName extends string,
>(options: {
  schema: AnySchema;
  table: AnyTable;
  columnName: string;
  externalId: string;
  endpointName: string;
  rowsStore: WriteStore<TxStores, StoreName>;
  referenceTargets: Map<string, ReferenceTarget>;
}): Promise<number | undefined> => {
  const { schema, table, columnName, externalId, endpointName, rowsStore, referenceTargets } =
    options;
  const target = referenceTargets.get(`${schema.name}::${table.name}::${columnName}`);
  if (!target) {
    return undefined;
  }
  const key: LofiRow["key"] = [endpointName, target.schema, target.table, externalId];
  const referenced = (await rowsStore.get(key)) as LofiRow | undefined;
  if (!referenced) {
    return undefined;
  }
  return referenced._lofi.internalId;
};

const coerceInternalIdValue = (
  value: bigint | number,
  schema: AnySchema,
  table: AnyTable,
  columnName: string,
): number => {
  const asNumber = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error(
      `Reference internalId is not a safe integer for ${schema.name}.${table.name}.${columnName}: ${value.toString()}`,
    );
  }
  return asNumber;
};
