import { FragnoId, FragnoReference, type AnySchema, type AnyTable } from "@fragno-dev/db/schema";

import {
  createSchemaMaps,
  getKnownMutation,
  mergeSchemaLists,
  resolveLofiSchemaName,
  withLofiSchemaName,
  type LofiSchemaNameAliases,
  type ProjectionQueuedMutation,
} from "../local/projection";
import { runLocalProjections } from "../local/run-projections";
import { resolveMutation } from "../query/mutation-values";
import type {
  AnyLofiLocalProjection,
  LofiAdapter,
  LofiMutation,
  LofiOutboxWriter,
  LofiSchemaRegistration,
} from "../types";
import { inlineSqliteParams } from "./inline";
import {
  createSqliteTableLayouts,
  createSqliteTableStatements,
  quoteSqliteIdentifier,
  registeredSchemaName,
  type SqliteTableLayout,
} from "./layout";
import { decodeLofiSqliteRow, encodeSqliteValue, type SqliteValue } from "./values";

/**
 * One SQLite connection. Matches `openBrowserWASQLiteOPFSDatabase` from TanStack DB. A call without
 * `params` may hold several statements separated by semicolons; it runs them in order and returns
 * the rows of all of them.
 */
export type LofiSqliteDatabase = {
  execute(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<ReadonlyArray<Record<string, unknown>>>;
};

export type SqliteLofiAdapterOptions = {
  database: LofiSqliteDatabase;
  /** Source schemas mirrored from the outbox; mutations for other schemas are skipped. */
  schemas: LofiSchemaRegistration[];
  /** Schemas written only by projections. */
  localSchemas: LofiSchemaRegistration[];
  projections: AnyLofiLocalProjection[];
};

type SqlFragment = { sql: string; params: SqliteValue[] };

type OutboxEntryOptions = Parameters<LofiAdapter["applyOutboxEntry"]>[0];

/** Queued statements are sent once their SQL reaches this many characters. */
const MAX_QUEUED_SQL_LENGTH = 1_000_000;

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "lofi_meta" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)`,
];

/**
 * Prefixes the `lofi_meta` key holding the last versionstamp applied from a source. An outbox
 * delivers unique versionstamps in ascending order, so every entry at or below it was applied. This
 * differs from the client's cursor, which can stay behind applied entries while an ephemeral stream
 * is open, so the entries after the cursor arrive again.
 */
const APPLIED_THROUGH_KEY_PREFIX = "applied-through:";

/** Each source's applied-through versionstamp, read once per transaction and written before it commits. */
type AppliedThrough = {
  isApplied(sourceKey: string, versionstamp: string): Promise<boolean>;
  record(sourceKey: string, versionstamp: string): void;
  write(): Promise<void>;
};

/**
 * Mirrors outbox entries and local projections into SQLite tables laid out like the backend's,
 * so applications can read them with plain SQL.
 */
export class SqliteLofiAdapter implements LofiAdapter {
  readonly #database: LofiSqliteDatabase;
  readonly #layouts: ReadonlyMap<string, ReadonlyMap<string, SqliteTableLayout>>;
  readonly #schemaMap: Map<string, AnySchema>;
  readonly #tableMap: Map<string, Map<string, AnyTable>>;
  readonly #localSchemaMap: Map<string, AnySchema>;
  readonly #localTableMap: Map<string, Map<string, AnyTable>>;
  readonly #schemaNameAliases: LofiSchemaNameAliases;
  readonly #projections: AnyLofiLocalProjection[];
  // Statements of one transaction span several `execute` calls on a shared connection, so every
  // statement waits for the previous operation to finish.
  #tail: Promise<unknown> = Promise.resolve();
  // Each `execute` is a round trip to the database's worker, which cost more than the statements
  // themselves. Inside a transaction, statements that return no rows queue here, with their
  // parameters written in, and go together with the next read or the `COMMIT`. Null outside one.
  #queue: string[] | null = null;
  #queuedLength = 0;

  private constructor(options: SqliteLofiAdapterOptions) {
    const sourceSchemas = options.schemas.map(toRegisteredSchema);
    const localSchemas = options.localSchemas.map(toRegisteredSchema);
    mergeSchemaLists(sourceSchemas, localSchemas, "SqliteLofiAdapter");
    const { schemaMap, tableMap } = createSchemaMaps(sourceSchemas, "SqliteLofiAdapter");
    const { schemaMap: localSchemaMap, tableMap: localTableMap } = createSchemaMaps(
      localSchemas,
      "SqliteLofiAdapter local",
    );

    this.#database = {
      execute: (sql, params) => options.database.execute(sql, params?.map(bindableValue)),
    };
    this.#layouts = new Map(
      [...options.schemas, ...options.localSchemas].map((registration) => [
        registeredSchemaName(registration),
        createSqliteTableLayouts(registration),
      ]),
    );
    this.#schemaMap = schemaMap;
    this.#tableMap = tableMap;
    this.#localSchemaMap = localSchemaMap;
    this.#localTableMap = localTableMap;
    this.#schemaNameAliases = new Map(
      [...options.schemas, ...options.localSchemas].flatMap((registration) => {
        const schemaName = registeredSchemaName(registration);
        return [
          [registration.schema.name, schemaName],
          [schemaName, schemaName],
        ] as const;
      }),
    );
    this.#projections = options.projections;
  }

  /** Creates missing tables and indexes. Existing tables are never migrated; see the README. */
  static async open(options: SqliteLofiAdapterOptions): Promise<SqliteLofiAdapter> {
    const adapter = new SqliteLofiAdapter(options);
    const statements = [
      ...SCHEMA_STATEMENTS,
      ...[...options.schemas, ...options.localSchemas].flatMap((registration) =>
        [...createSqliteTableLayouts(registration).values()].flatMap((layout) =>
          createSqliteTableStatements(registration, layout),
        ),
      ),
    ];
    await adapter.#transaction(async () => {
      for (const statement of statements) {
        await adapter.#write(statement);
      }
    });
    return adapter;
  }

  /** Runs SQL after pending replication writes, so reads never observe half-applied entries. */
  execute(
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    return this.#serialize(() => this.#database.execute(sql, params));
  }

  applyOutboxEntry(options: OutboxEntryOptions): Promise<{ applied: boolean }> {
    return this.#transaction(async () => {
      const appliedThrough = this.#readAppliedThrough();
      const result = await this.#applyOutboxEntryInTransaction(options, appliedThrough);
      await appliedThrough.write();
      return result;
    });
  }

  /**
   * Applies the batch in one transaction, which saves the commit and the journaling of shared pages,
   * such as the cursor's and the indexes', that every entry would otherwise pay for. A failure rolls
   * back the whole batch.
   */
  applyOutboxBatch<T>(apply: (writer: LofiOutboxWriter) => Promise<T>): Promise<T> {
    return this.#transaction(async () => {
      const appliedThrough = this.#readAppliedThrough();
      let open = true;
      const whileOpen = <R>(operation: () => Promise<R>): Promise<R> =>
        open ? operation() : Promise.reject(new Error("The outbox batch has ended."));
      let result: T;
      try {
        result = await apply({
          applyOutboxEntry: (options) =>
            whileOpen(() => this.#applyOutboxEntryInTransaction(options, appliedThrough)),
          setMeta: (key, value) => whileOpen(() => this.#writeMeta(key, value)),
        });
      } finally {
        open = false;
      }
      await appliedThrough.write();
      return result;
    });
  }

  async #applyOutboxEntryInTransaction(
    options: OutboxEntryOptions,
    appliedThrough: AppliedThrough,
  ): Promise<{ applied: boolean }> {
    const knownMutations = options.mutations.flatMap((mutation) => {
      const known = this.#getKnownSourceMutation(mutation);
      return known ? [known] : [];
    });

    if (await appliedThrough.isApplied(options.sourceKey, options.versionstamp)) {
      return { applied: false };
    }

    const baseNow = Date.now();
    const mutations = knownMutations.map((mutation) => resolveMutation(mutation, baseNow));
    for (const mutation of mutations) {
      await this.#writeMutation(this.#getLayout(mutation.schema, mutation.table), mutation);
    }

    await runLocalProjections({
      projections: this.#projections,
      mutations,
      source: {
        sourceKey: options.sourceKey,
        uowId: options.uowId,
        versionstamp: options.versionstamp,
      },
      localSchemaMap: this.#localSchemaMap,
      localTableMap: this.#localTableMap,
      schemaNameAliases: this.#schemaNameAliases,
      readRow: async (target, externalId) => {
        const layout = this.#getLayout(target.schema.name, target.table.name);
        const [row] = await this.#read(
          `SELECT * FROM ${quoteSqliteIdentifier(layout.sqlName)} WHERE ${idColumn(layout)} = ?`,
          [externalId],
        );
        return row ? decodeLofiSqliteRow(layout.table, row) : undefined;
      },
      writeMutation: (mutation, target) =>
        this.#writeMutation(
          this.#getLayout(target.schema.name, target.table.name),
          resolveMutation(mutation, baseNow) as ProjectionQueuedMutation,
        ),
    });

    appliedThrough.record(options.sourceKey, options.versionstamp);
    return { applied: true };
  }

  async getMeta(key: string): Promise<string | undefined> {
    const [row] = await this.execute(`SELECT "value" FROM "lofi_meta" WHERE "key" = ?`, [key]);
    return row ? (row["value"] as string) : undefined;
  }

  setMeta(key: string, value: string): Promise<void> {
    return this.#serialize(() => this.#writeMeta(key, value));
  }

  /** Call inside a transaction, which keeps other connections from moving the watermarks meanwhile. */
  #readAppliedThrough(): AppliedThrough {
    const read = new Map<string, Promise<string | undefined>>();
    const recorded = new Map<string, string>();
    return {
      isApplied: async (sourceKey, versionstamp) => {
        const key = `${APPLIED_THROUGH_KEY_PREFIX}${sourceKey}`;
        if (!read.has(key)) {
          read.set(
            key,
            this.#read(`SELECT "value" FROM "lofi_meta" WHERE "key" = ?`, [key]).then(([row]) =>
              row ? (row["value"] as string) : undefined,
            ),
          );
        }
        const through = recorded.get(key) ?? (await read.get(key));
        return through !== undefined && versionstamp <= through;
      },
      record: (sourceKey, versionstamp) => {
        recorded.set(`${APPLIED_THROUGH_KEY_PREFIX}${sourceKey}`, versionstamp);
      },
      write: async () => {
        for (const [key, versionstamp] of recorded) {
          await this.#writeMeta(key, versionstamp);
        }
      },
    };
  }

  async #writeMeta(key: string, value: string): Promise<void> {
    await this.#write(
      `INSERT INTO "lofi_meta" ("key", "value") VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value"`,
      [key, value],
    );
  }

  /** Skips schemas this replica does not mirror; an unknown table in a mirrored schema throws. */
  #getKnownSourceMutation(mutation: LofiMutation): LofiMutation | undefined {
    const schemaName = resolveLofiSchemaName(mutation.schema, this.#schemaNameAliases);
    if (!this.#schemaMap.has(schemaName)) {
      return undefined;
    }
    return getKnownMutation({
      mutation,
      schemaMap: this.#schemaMap,
      tableMap: this.#tableMap,
      ignoreUnknownSchemas: false,
      schemaErrorPrefix: "Unknown outbox schema",
      tableErrorPrefix: "Unknown outbox table",
      schemaNameAliases: this.#schemaNameAliases,
    })?.mutation;
  }

  #getLayout(schemaName: string, tableName: string): SqliteTableLayout {
    const layout = this.#layouts.get(schemaName)?.get(tableName);
    if (!layout) {
      throw new Error(`Unknown SQLite replica table: ${schemaName}.${tableName}`);
    }
    return layout;
  }

  async #writeMutation(
    layout: SqliteTableLayout,
    mutation: LofiMutation | ProjectionQueuedMutation,
  ): Promise<void> {
    const table = quoteSqliteIdentifier(layout.sqlName);
    const id = idColumn(layout);

    if (mutation.op === "delete") {
      await this.#write(`DELETE FROM ${table} WHERE ${id} = ?`, [mutation.externalId]);
      return;
    }

    if (mutation.op === "create") {
      const assignments = columnAssignments(layout, mutation.values);
      const columns = [id, ...assignments.map(({ column }) => column)];
      const values = [{ sql: "?", params: [mutation.externalId] }, ...assignments];
      // Merges into an existing row like an update, keeping its internal id and version.
      const onConflict =
        assignments.length === 0
          ? "DO NOTHING"
          : `DO UPDATE SET ${assignments
              .map(({ column }) => `${column} = excluded.${column}`)
              .join(", ")}`;
      await this.#write(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values
          .map(({ sql }) => sql)
          .join(", ")}) ON CONFLICT (${id}) ${onConflict}`,
        values.flatMap(({ params }) => params),
      );
      return;
    }

    const version = quoteSqliteIdentifier(layout.table.getVersionColumn().name);
    const assignments = [
      ...columnAssignments(layout, mutation.set).map(({ column, sql, params }) => ({
        sql: `${column} = ${sql}`,
        params,
      })),
      { sql: `${version} = ${version} + 1`, params: [] },
    ];
    const checkVersion = "checkVersion" in mutation && mutation.checkVersion === true;
    const where = checkVersion
      ? {
          sql: `${id} = ? AND ${version} = ?`,
          params: [mutation.externalId, mutation.expectedVersion!],
        }
      : { sql: `${id} = ?`, params: [mutation.externalId] };
    const update = `UPDATE ${table} SET ${assignments.map(({ sql }) => sql).join(", ")} WHERE ${where.sql}`;
    const params = [...assignments.flatMap(({ params }) => params), ...where.params];
    if (!checkVersion) {
      await this.#write(update, params);
      return;
    }
    const updated = await this.#read(`${update} RETURNING ${id}`, params);
    if (updated.length === 0) {
      throw new Error(`Projection update check failed: ${layout.sqlName}.${mutation.externalId}`);
    }
  }

  /** Queues a statement that returns no rows when inside a transaction, or runs it. */
  async #write(sql: string, params: ReadonlyArray<unknown> = []): Promise<void> {
    const queue = this.#queue;
    const inlined = queue === null ? null : inlineSqliteParams(sql, params.map(bindableValue));
    if (queue === null || inlined === null) {
      await this.#flush();
      await this.#database.execute(sql, params);
      return;
    }
    queue.push(inlined);
    this.#queuedLength += inlined.length;
    if (this.#queuedLength >= MAX_QUEUED_SQL_LENGTH) {
      await this.#flush();
    }
  }

  /** Runs a statement after the queued ones, in the same call when its parameters can be written in. */
  async #read(
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    const queued = this.#takeQueued();
    if (queued.length === 0) {
      return await this.#database.execute(sql, params);
    }
    const inlined = inlineSqliteParams(sql, params.map(bindableValue));
    if (inlined === null) {
      await this.#database.execute(queued.join(";\n"));
      return await this.#database.execute(sql, params);
    }
    // Queued statements return no rows, so every row is the read's.
    return await this.#database.execute([...queued, inlined].join(";\n"));
  }

  /** Sends the queued statements, followed by `last`. */
  async #flush(last?: string): Promise<void> {
    const statements = this.#takeQueued();
    if (last !== undefined) {
      statements.push(last);
    }
    if (statements.length > 0) {
      await this.#database.execute(statements.join(";\n"));
    }
  }

  #takeQueued(): string[] {
    const queued = this.#queue;
    if (queued === null || queued.length === 0) {
      return [];
    }
    this.#queue = [];
    this.#queuedLength = 0;
    return queued;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.catch(() => {});
    return result;
  }

  #transaction<T>(operation: () => Promise<T>): Promise<T> {
    return this.#serialize(async () => {
      // BEGIN goes with the transaction's first statements.
      this.#queue = ["BEGIN IMMEDIATE"];
      this.#queuedLength = 0;
      try {
        const result = await operation();
        await this.#flush("COMMIT");
        return result;
      } catch (error) {
        // A failed ROLLBACK means SQLite already ended the transaction, or never began it; the cause
        // is more useful.
        await this.#database.execute("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        this.#queue = null;
        this.#queuedLength = 0;
      }
    });
  }
}

function toRegisteredSchema(registration: LofiSchemaRegistration): AnySchema {
  return withLofiSchemaName(registration.schema, registeredSchemaName(registration));
}

function idColumn(layout: SqliteTableLayout): string {
  return quoteSqliteIdentifier(layout.table.getIdColumn().name);
}

/** Value assignments for the writable columns present in `values`. */
function columnAssignments(
  layout: SqliteTableLayout,
  values: Record<string, unknown>,
): Array<SqlFragment & { column: string }> {
  return Object.entries(layout.table.columns).flatMap(([key, column]) => {
    if (!(key in values) || (column.role !== "regular" && column.role !== "reference")) {
      return [];
    }
    const value = values[key];
    const assignment =
      column.role === "reference"
        ? referenceValue(layout.referenceLookups.get(column.name)!, value)
        : { sql: "?", params: [encodeSqliteValue(column, value)] };
    return [{ column: quoteSqliteIdentifier(column.name), ...assignment }];
  });
}

/**
 * References are stored as the referenced row's local internal id. A reference to a row the
 * replica does not hold is stored as NULL.
 */
function referenceValue(lookup: string, value: unknown): SqlFragment {
  if (value === null || value === undefined) {
    return { sql: "?", params: [null] };
  }
  if (value instanceof FragnoReference) {
    return { sql: "?", params: [value.internalId] };
  }
  if (value instanceof FragnoId && value.internalId !== undefined) {
    return { sql: "?", params: [value.internalId] };
  }
  const externalId = value instanceof FragnoId ? value.externalId : (value as string);
  return { sql: lookup, params: [externalId] };
}

/**
 * wa-sqlite binds a number outside the 32-bit range, such as a timestamp, as REAL. Columns with
 * INTEGER affinity store it as an integer again, but in expressions it stays REAL, so
 * `("occurredAt" - ?) / ?` would divide in floating point. Whole numbers bind as 64-bit integers.
 */
function bindableValue(value: unknown): unknown {
  return typeof value === "number" && Number.isSafeInteger(value) && value !== (value | 0)
    ? BigInt(value)
    : value;
}
