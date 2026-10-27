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
import {
  createSqliteTableLayouts,
  createSqliteTableStatements,
  quoteSqliteIdentifier,
  registeredSchemaName,
  type SqliteTableLayout,
} from "./layout";
import {
  planProjectionRebuilds,
  PROJECTION_META_KEY_PREFIX,
  type ProjectionRebuildPlan,
} from "./rebuild";
import {
  decodeLofiSqliteRow,
  decodeSqliteValue,
  encodeSqliteValue,
  type SqliteValue,
} from "./values";

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

/**
 * What a write transaction reads of `lofi_meta` once and writes before it commits: each source's
 * applied-through versionstamp, and whether the rebuildable projections' tables match their code.
 */
type TransactionMeta = {
  isApplied(sourceKey: string, versionstamp: string): Promise<boolean>;
  record(sourceKey: string, versionstamp: string): void;
  /** Rebuilds the projections whose stored fingerprint differs, once per transaction. */
  rebuildStaleProjections(): Promise<void>;
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
  readonly #rebuilds: ProjectionRebuildPlan[];
  // Statements of one transaction span several `execute` calls on a shared connection, so every
  // statement waits for the previous operation to finish.
  #tail: Promise<unknown> = Promise.resolve();
  // The last database call. The database steps through a call's statements asynchronously, so two
  // calls in flight, such as a projection's concurrent reads and a write, would interleave.
  #lastCall: Promise<unknown> = Promise.resolve();
  // Tables written since `takeChangedTables` last returned them, by SQL name. A transaction that
  // rolls back leaves its tables here, which only refreshes views for nothing.
  readonly #changedTables = new Set<string>();

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
      execute: (sql, params) => {
        const call = this.#lastCall.then(() =>
          options.database.execute(sql, params?.map(bindableValue)),
        );
        this.#lastCall = call.catch(() => {});
        return call;
      },
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
    this.#rebuilds = planProjectionRebuilds(options);
  }

  /**
   * Creates missing tables and indexes, and rebuilds the projections whose code changed. Other
   * existing tables are never migrated; see the README.
   */
  static async open(options: SqliteLofiAdapterOptions): Promise<SqliteLofiAdapter> {
    const adapter = new SqliteLofiAdapter(options);
    // A rebuild creates its projection's tables, which may have changed since they were created.
    const rebuilt = new Set(
      adapter.#rebuilds.flatMap(({ writes }) => writes.map(({ layout }) => layout.table)),
    );
    const statements = [
      ...SCHEMA_STATEMENTS,
      ...[...options.schemas, ...options.localSchemas].flatMap((registration) =>
        [...createSqliteTableLayouts(registration).values()].flatMap((layout) =>
          rebuilt.has(layout.table) ? [] : createSqliteTableStatements(registration, layout),
        ),
      ),
    ];
    await adapter.#transaction(async () => {
      for (const statement of statements) {
        await adapter.#database.execute(statement);
      }
      await adapter.#readTransactionMeta().rebuildStaleProjections();
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

  /**
   * Runs `read` in a transaction between replication writes. Once `read` has read, the connection
   * holds its lock until `read` settles, so no connection writes meanwhile.
   */
  read<T>(read: (database: LofiSqliteDatabase) => Promise<T>): Promise<T> {
    return this.#serialize(async () => {
      await this.#database.execute("BEGIN");
      try {
        const result = await read(this.#database);
        await this.#database.execute("COMMIT");
        return result;
      } catch (error) {
        await this.#database.execute("ROLLBACK").catch(() => {});
        throw error;
      }
    });
  }

  applyOutboxEntry(options: OutboxEntryOptions): Promise<{ applied: boolean }> {
    return this.#transaction(async () => {
      const meta = this.#readTransactionMeta();
      const result = await this.#applyOutboxEntryInTransaction(options, meta);
      await meta.write();
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
      const meta = this.#readTransactionMeta();
      let open = true;
      const whileOpen = <R>(operation: () => Promise<R>): Promise<R> =>
        open ? operation() : Promise.reject(new Error("The outbox batch has ended."));
      let result: T;
      try {
        result = await apply({
          applyOutboxEntry: (options) =>
            whileOpen(() => this.#applyOutboxEntryInTransaction(options, meta)),
          setMeta: (key, value) => whileOpen(() => this.#writeMeta(key, value)),
        });
      } finally {
        open = false;
      }
      await meta.write();
      return result;
    });
  }

  async #applyOutboxEntryInTransaction(
    options: OutboxEntryOptions,
    meta: TransactionMeta,
  ): Promise<{ applied: boolean }> {
    const knownMutations = options.mutations.flatMap((mutation) => {
      const known = this.#getKnownSourceMutation(mutation);
      return known ? [known] : [];
    });

    if (await meta.isApplied(options.sourceKey, options.versionstamp)) {
      return { applied: false };
    }
    // Before the entry's rows are written, which a rebuild would replay as well.
    await meta.rebuildStaleProjections();

    const baseNow = Date.now();
    const mutations = knownMutations.map((mutation) => resolveMutation(mutation, baseNow));
    for (const mutation of mutations) {
      await this.#writeMutation(this.#getLayout(mutation.schema, mutation.table), mutation);
    }

    await this.#runProjections(this.#projections, mutations, baseNow, {
      sourceKey: options.sourceKey,
      uowId: options.uowId,
      versionstamp: options.versionstamp,
    });

    meta.record(options.sourceKey, options.versionstamp);
    return { applied: true };
  }

  #runProjections(
    projections: readonly AnyLofiLocalProjection[],
    mutations: readonly LofiMutation[],
    baseNow: number,
    source: { sourceKey?: string; uowId?: string; versionstamp: string },
  ): Promise<void> {
    return runLocalProjections({
      projections,
      mutations,
      source,
      localSchemaMap: this.#localSchemaMap,
      localTableMap: this.#localTableMap,
      schemaNameAliases: this.#schemaNameAliases,
      readRow: async (target, externalId) => {
        const layout = this.#getLayout(target.schema.name, target.table.name);
        const [row] = await this.#database.execute(
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
  }

  /**
   * Recreates the projection's tables and runs it on the stored rows of its source tables, in the
   * order they were stored, which is the order the outbox delivered them. Call inside a transaction.
   */
  async #rebuild(plan: ProjectionRebuildPlan): Promise<void> {
    for (const { registration, layout } of plan.writes) {
      // A table the rebuild leaves empty is changed too.
      this.#changedTables.add(layout.sqlName);
      await this.#database.execute(`DROP TABLE IF EXISTS ${quoteSqliteIdentifier(layout.sqlName)}`);
      for (const statement of createSqliteTableStatements(registration, layout)) {
        await this.#database.execute(statement);
      }
    }
    for (const { schemaName, layout, nextPage } of plan.from) {
      const internalId = layout.table.getInternalIdColumn().name;
      let after: unknown = 0;
      for (;;) {
        const rows = await this.#database.execute(nextPage, [after]);
        if (rows.length === 0) {
          break;
        }
        after = rows.at(-1)![internalId];
        await this.#runProjections(
          [plan.projection],
          rows.map((row) => storedRowAsCreate(schemaName, layout, row)),
          Date.now(),
          { versionstamp: "" },
        );
      }
    }
    await this.#writeMeta(plan.metaKey, plan.fingerprint);
  }

  /** The tables written since the last call, by SQL name, such as to refresh views that read them. */
  takeChangedTables(): string[] {
    const tables = [...this.#changedTables];
    this.#changedTables.clear();
    return tables;
  }

  async getMeta(key: string): Promise<string | undefined> {
    const [row] = await this.execute(`SELECT "value" FROM "lofi_meta" WHERE "key" = ?`, [key]);
    return row ? (row["value"] as string) : undefined;
  }

  setMeta(key: string, value: string): Promise<void> {
    return this.#serialize(() => this.#writeMeta(key, value));
  }

  /**
   * Call inside a transaction, which keeps other connections from moving the watermarks or
   * rebuilding meanwhile. The first read also fetches the projections' fingerprints, so checking
   * them costs no statement of its own.
   */
  #readTransactionMeta(): TransactionMeta {
    const read = new Map<string, Promise<string | undefined>>();
    const recorded = new Map<string, string>();
    let fingerprints: Promise<ReadonlyMap<string, string>> | undefined;
    let projectionsChecked = this.#rebuilds.length === 0;
    const readMeta = (keys: string[]) => {
      const withFingerprints = !projectionsChecked && fingerprints === undefined;
      const rows = this.#database
        .execute(
          `SELECT "key", "value" FROM "lofi_meta" WHERE "key" IN (${keys.map(() => "?").join(", ")})${
            withFingerprints ? ` OR substr("key", 1, ${PROJECTION_META_KEY_PREFIX.length}) = ?` : ""
          }`,
          withFingerprints ? [...keys, PROJECTION_META_KEY_PREFIX] : keys,
        )
        .then(
          (found) => new Map(found.map((row) => [row["key"] as string, row["value"] as string])),
        );
      if (withFingerprints) {
        fingerprints = rows;
      }
      return rows;
    };
    return {
      isApplied: async (sourceKey, versionstamp) => {
        const key = `${APPLIED_THROUGH_KEY_PREFIX}${sourceKey}`;
        if (!read.has(key)) {
          read.set(
            key,
            readMeta([key]).then((values) => values.get(key)),
          );
        }
        const through = recorded.get(key) ?? (await read.get(key));
        return through !== undefined && versionstamp <= through;
      },
      record: (sourceKey, versionstamp) => {
        recorded.set(`${APPLIED_THROUGH_KEY_PREFIX}${sourceKey}`, versionstamp);
      },
      rebuildStaleProjections: async () => {
        if (projectionsChecked) {
          return;
        }
        const stored = await (fingerprints ?? readMeta([]));
        projectionsChecked = true;
        for (const plan of this.#rebuilds) {
          if (stored.get(plan.metaKey) !== plan.fingerprint) {
            await this.#rebuild(plan);
          }
        }
      },
      write: async () => {
        for (const [key, versionstamp] of recorded) {
          await this.#writeMeta(key, versionstamp);
        }
      },
    };
  }

  async #writeMeta(key: string, value: string): Promise<void> {
    await this.#database.execute(
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
    this.#changedTables.add(layout.sqlName);

    if (mutation.op === "delete") {
      await this.#database.execute(`DELETE FROM ${table} WHERE ${id} = ?`, [mutation.externalId]);
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
      await this.#database.execute(
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
      await this.#database.execute(update, params);
      return;
    }
    const updated = await this.#database.execute(`${update} RETURNING ${id}`, params);
    if (updated.length === 0) {
      throw new Error(`Projection update check failed: ${layout.sqlName}.${mutation.externalId}`);
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.catch(() => {});
    return result;
  }

  #transaction<T>(operation: () => Promise<T>): Promise<T> {
    return this.#serialize(async () => {
      await this.#database.execute("BEGIN IMMEDIATE");
      try {
        const result = await operation();
        await this.#database.execute("COMMIT");
        return result;
      } catch (error) {
        // A failed ROLLBACK means SQLite already ended the transaction, or never began it; the cause
        // is more useful.
        await this.#database.execute("ROLLBACK").catch(() => {});
        throw error;
      }
    });
  }
}

function toRegisteredSchema(registration: LofiSchemaRegistration): AnySchema {
  return withLofiSchemaName(registration.schema, registeredSchemaName(registration));
}

/** A stored row as the `create` mutation the outbox would have delivered it with. */
function storedRowAsCreate(
  schemaName: string,
  layout: SqliteTableLayout,
  row: Readonly<Record<string, unknown>>,
): LofiMutation {
  const externalId = row[layout.table.getIdColumn().name] as string;
  const values: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(layout.table.columns)) {
    if (column.role === "regular") {
      values[key] = decodeSqliteValue(column, row[column.name]);
    } else if (column.role === "reference" || column.role === "external-id") {
      values[key] = row[column.name];
    }
  }
  return {
    op: "create",
    schema: schemaName,
    table: layout.table.name,
    externalId,
    values,
    versionstamp: "",
  };
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
