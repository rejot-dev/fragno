import type { AnyColumn, AnySchema, AnyTable } from "@fragno-dev/db/schema";
import { generateMigrationFromSchema } from "@fragno-dev/db/client";
import type {
  IndexedDbAdapterOptions,
  LofiAdapter,
  LofiMutation,
  LofiQueryEngineOptions,
  LofiQueryInterface,
  LofiQueryableAdapter,
} from "../types";
import { requestToPromise, transactionDone } from "./idb-utils";
import type { ReferenceTarget } from "./types";
import { normalizeValue } from "../query/normalize";
import { createIndexedDbQueryEngine } from "../query/engine";

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

  private dbPromise?: Promise<IDBDatabase>;

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

    const existingInbox = await requestToPromise<InboxRow | undefined>(
      inboxStore.get([options.sourceKey, options.uowId]),
    );
    if (existingInbox) {
      await transactionDone(tx);
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
      inboxStore.put(inboxRow);

      await transactionDone(tx);
      return { applied: true };
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // Ignore abort errors; transaction will already be closing.
      }
      try {
        await transactionDone(tx);
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
    const row = await requestToPromise<MetaRow | undefined>(store.get(key));
    await transactionDone(tx);
    return row?.value;
  }

  async setMeta(key: string, value: string): Promise<void> {
    const db = await this.openDatabase();
    const tx = db.transaction(META_STORE, "readwrite");
    const store = tx.objectStore(META_STORE);
    store.put({ key, value });
    await transactionDone(tx);
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

  private openDatabase(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = this.openDatabaseInternal();
    }
    return this.dbPromise;
  }

  private async openDatabaseInternal(): Promise<IDBDatabase> {
    const initialDb = await openDatabaseWithUpgrade(this.dbName, undefined, (db, tx) => {
      ensureStores(db, tx);
      ensureIndexes(tx, this.indexDefinitions);
      setMetaInTransaction(tx, schemaFingerprintKey(this.endpointName), this.schemaFingerprint);
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

    const upgraded = await openDatabaseWithUpgrade(this.dbName, currentVersion + 1, (db, tx) => {
      ensureStores(db, tx);
      ensureIndexes(tx, this.indexDefinitions);
      clearEndpointData(tx, this.endpointName);
      setMetaInTransaction(tx, schemaFingerprintKey(this.endpointName), this.schemaFingerprint);
    });

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

const ensureStores = (db: IDBDatabase, tx: IDBTransaction): void => {
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

const ensureIndexes = (tx: IDBTransaction, indexes: IndexDefinition[]): void => {
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

const clearEndpointData = (tx: IDBTransaction, endpointName: string): void => {
  const rowsStore = tx.objectStore(ROWS_STORE);
  const inboxStore = tx.objectStore(INBOX_STORE);
  const metaStore = tx.objectStore(META_STORE);

  deleteRowsForEndpoint(rowsStore, endpointName);
  void deleteWhere(
    inboxStore,
    (row) => isInboxRow(row) && row.sourceKey.startsWith(`${endpointName}::`),
  );
  void deleteWhere(
    metaStore,
    (row) => isMetaRow(row) && row.key === cursorKeyDefault(endpointName),
  );
};

const deleteRowsForEndpoint = (store: IDBObjectStore, endpointName: string): void => {
  const index = store.index(INDEX_SCHEMA_TABLE);
  const range = IDBKeyRange.bound([endpointName], [endpointName, "\uffff", "\uffff"]);
  const request = index.openCursor(range);
  request.onsuccess = () => {
    const cursor = request.result as IDBCursorWithValue | null;
    if (!cursor) {
      return;
    }
    store.delete(cursor.primaryKey);
    cursor.continue();
  };
};

const deleteWhere = (store: IDBObjectStore, predicate: (value: unknown) => boolean): void => {
  const request = store.openCursor();
  request.onsuccess = () => {
    const cursor = request.result as IDBCursorWithValue | null;
    if (!cursor) {
      return;
    }
    if (predicate(cursor.value)) {
      cursor.delete();
    }
    cursor.continue();
  };
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
  onUpgrade: (db: IDBDatabase, tx: IDBTransaction) => void,
): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request =
      version === undefined ? indexedDB.open(dbName) : indexedDB.open(dbName, version);

    request.onupgradeneeded = () => {
      const db = request.result;
      const tx = request.transaction;
      if (!tx) {
        throw new Error("IndexedDbAdapter upgrade transaction missing.");
      }
      onUpgrade(db, tx);
    };

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });

const readMetaValue = async (db: IDBDatabase, key: string): Promise<string | undefined> => {
  if (!db.objectStoreNames.contains(META_STORE)) {
    return undefined;
  }
  const tx = db.transaction(META_STORE, "readonly");
  const store = tx.objectStore(META_STORE);
  const row = await requestToPromise<MetaRow | undefined>(store.get(key));
  await transactionDone(tx);
  return row?.value;
};

const setMetaInTransaction = (tx: IDBTransaction, key: string, value: string): void => {
  const store = tx.objectStore(META_STORE);
  store.put({ key, value });
};

const applyMutation = async (options: {
  mutation: LofiMutation;
  schema: AnySchema;
  table: AnyTable;
  endpointName: string;
  rowsStore: IDBObjectStore;
  metaStore: IDBObjectStore;
  referenceTargets: Map<string, ReferenceTarget>;
}): Promise<void> => {
  const { mutation, schema, table, endpointName, rowsStore, metaStore, referenceTargets } = options;

  const key: LofiRow["key"] = [endpointName, schema.name, table.name, mutation.externalId];
  const existing = await requestToPromise<LofiRow | undefined>(rowsStore.get(key));

  if (mutation.op === "delete") {
    if (existing) {
      rowsStore.delete(key);
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

  rowsStore.put(row);
};

const allocateInternalId = async (
  metaStore: IDBObjectStore,
  endpointName: string,
  schemaName: string,
  tableName: string,
): Promise<number> => {
  const key = seqKey(endpointName, schemaName, tableName);
  const existing = await requestToPromise<MetaRow | undefined>(metaStore.get(key));
  const next = existing ? Number(existing.value) + 1 : 1;
  if (Number.isNaN(next) || next > Number.MAX_SAFE_INTEGER) {
    throw new Error(
      `IndexedDbAdapter internalId overflow for ${schemaName}.${tableName}: ${existing?.value}`,
    );
  }
  metaStore.put({ key, value: String(next) });
  return next;
};

const buildNormalizedValues = async (options: {
  schema: AnySchema;
  table: AnyTable;
  data: Record<string, unknown>;
  rowId: string;
  internalId: number;
  version: number;
  endpointName: string;
  rowsStore: IDBObjectStore;
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

const resolveColumnValue = async (options: {
  schema: AnySchema;
  table: AnyTable;
  columnName: string;
  column: AnyColumn;
  data: Record<string, unknown>;
  rowId: string;
  internalId: number;
  version: number;
  endpointName: string;
  rowsStore: IDBObjectStore;
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
    if (typeof rawValue !== "string") {
      throw new Error(
        `Expected reference value to be external ID string for ${schema.name}.${table.name}.${columnName}.`,
      );
    }
    const target = referenceTargets.get(`${schema.name}::${table.name}::${columnName}`);
    if (!target) {
      return undefined;
    }
    const key: LofiRow["key"] = [endpointName, target.schema, target.table, rawValue];
    const referenced = await requestToPromise<LofiRow | undefined>(rowsStore.get(key));
    if (!referenced) {
      return undefined;
    }
    return referenced._lofi.internalId;
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
