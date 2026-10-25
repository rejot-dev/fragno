import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import SQLiteESMFactory from "@journeyapps/wa-sqlite/dist/wa-sqlite.mjs";
import { MemoryVFS } from "@journeyapps/wa-sqlite/src/examples/MemoryVFS.js";

import * as SQLite from "@journeyapps/wa-sqlite";

import { SqliteLofiAdapter, type LofiSqliteDatabase } from "./adapter";
import { connectLofiSqlite, type LofiSqliteClient } from "./client";
import { serveLofiSqlite, type LofiSqliteHost, type LofiSqliteHostOptions } from "./host";
import { quoteSqliteIdentifier } from "./layout";
import { planProjectionRebuilds } from "./rebuild";
import {
  LOFI_SQLITE_ENDPOINT_NAME,
  type LofiSqliteReplica,
  type LofiSqliteReplicaOptions,
} from "./replica";
import { wrapWaSqliteDatabase, type LofiSqliteSyncDatabase } from "./sync-connection";

/**
 * Opens replica databases in Node: one wa-sqlite module, the same SQLite build browsers run, whose
 * in-memory files every connection shares, like OPFS. Pass `open` as the replica's or the host's
 * `openDatabase` dependency.
 */
export async function openLofiSqliteMemoryFiles(options: {
  /** Delays every statement, like a slow OPFS write, to keep a catch-up observable. */
  statementDelayMs: number;
}) {
  const require = createRequire(import.meta.url);
  const module = await SQLiteESMFactory({
    wasmBinary: readFileSync(require.resolve("@journeyapps/wa-sqlite/dist/wa-sqlite.wasm")),
  });
  const sqlite3 = SQLite.Factory(module);
  // The bundled declarations omit the static factory.
  const vfs = await (
    MemoryVFS as unknown as { create(name: string, module: unknown): Promise<MemoryVFS> }
  ).create("lofi-memory", module);
  sqlite3.vfs_register(vfs as never, false);

  return {
    // A property rather than a method, so it can be passed on as the `openDatabase` dependency.
    open: async ({ databaseName }: { databaseName: string }): Promise<LofiSqliteSyncDatabase> => {
      const db = await sqlite3.open_v2(databaseName, undefined, "lofi-memory");
      const database = wrapWaSqliteDatabase({
        module,
        sqlite3,
        db,
        close: async () => {
          await sqlite3.close(db);
        },
      });
      return {
        ...database,
        async execute(sql, params) {
          if (options.statementDelayMs > 0) {
            await new Promise((resolve) => {
              setTimeout(resolve, options.statementDelayMs);
            });
          }
          return await database.execute(sql, params);
        },
      };
    },
  };
}

/**
 * Waits until the replica has applied the outbox up to `versionstamp`, such as the backend's
 * `currentVersionstamp` from `GET /_internal`.
 */
export async function waitForLofiSqliteReplica(
  replica: LofiSqliteReplica,
  versionstamp: string,
  options: { timeoutMs: number },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const [cursor] = await replica.execute(`SELECT "value" FROM "lofi_meta" WHERE "key" = ?`, [
      `${LOFI_SQLITE_ENDPOINT_NAME}::outbox`,
    ]);
    // Versionstamps are fixed-width hex, so their text order is their outbox order.
    if (cursor && (cursor["value"] as string) >= versionstamp) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for the replica to apply the outbox up to ${versionstamp}.`,
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

/**
 * Opens a tab as a page and its replica worker do, talking over a MessageChannel, and connects once
 * a tab has opened the replica. A tab whose connection fails is closed again.
 */
export async function openLofiSqliteTab(options: Omit<LofiSqliteHostOptions, "port">): Promise<{
  host: LofiSqliteHost;
  client: LofiSqliteClient;
  close(): Promise<void>;
}> {
  const channel = new MessageChannel();
  const host = serveLofiSqlite({ ...options, port: channel.port1 });
  const close = async () => {
    await host.close();
    channel.port1.close();
    channel.port2.close();
  };
  try {
    const client = await connectLofiSqlite({
      port: channel.port2,
      schemas: [...options.replica.schemas, ...options.replica.localSchemas],
    });
    return { host, client, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** A projection's tables by name, with each row's columns except its local internal id, by id. */
export type LofiSqliteProjectionTables = Record<string, Array<Record<string, unknown>>>;

/**
 * Rebuilds a replica's rebuildable projections from the rows it stores, as a replica running
 * changed projection code would, and returns their tables before and after. They match when each
 * projection gives the same rows however its input arrives. `database` is a connection of its own
 * to the replica's file; call this while the replica applies nothing, because the in-memory files
 * do not lock. The replica's writer rebuilds its own projections again before its next entry.
 */
export async function rebuildLofiSqliteProjections(
  options: Pick<LofiSqliteReplicaOptions, "schemas" | "localSchemas" | "projections"> & {
    database: LofiSqliteDatabase;
  },
): Promise<{ before: LofiSqliteProjectionTables; after: LofiSqliteProjectionTables }> {
  const tables = planProjectionRebuilds(options).flatMap(({ writes }) =>
    writes.map(({ layout }) => layout),
  );
  const read = async (
    database: Pick<LofiSqliteDatabase, "execute">,
  ): Promise<LofiSqliteProjectionTables> => {
    const read: LofiSqliteProjectionTables = {};
    for (const layout of tables) {
      const rows = await database.execute(
        `SELECT * FROM ${quoteSqliteIdentifier(layout.sqlName)} ORDER BY ${quoteSqliteIdentifier(
          layout.table.getIdColumn().name,
        )}`,
      );
      const internalId = layout.table.getInternalIdColumn().name;
      read[layout.sqlName] = rows.map((row) =>
        Object.fromEntries(Object.entries(row).filter(([column]) => column !== internalId)),
      );
    }
    return read;
  };

  const before = await read(options.database);
  const adapter = await SqliteLofiAdapter.open({
    database: options.database,
    schemas: options.schemas,
    localSchemas: options.localSchemas,
    projections: options.projections.map((projection) =>
      projection.rebuild
        ? {
            ...projection,
            rebuild: { ...projection.rebuild, version: projection.rebuild.version + 1 },
          }
        : projection,
    ),
  });
  return { before, after: await read(adapter) };
}
