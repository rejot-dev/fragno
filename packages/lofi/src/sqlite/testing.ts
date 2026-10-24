import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import SQLiteESMFactory from "@journeyapps/wa-sqlite/dist/wa-sqlite.mjs";
import { MemoryVFS } from "@journeyapps/wa-sqlite/src/examples/MemoryVFS.js";

import * as SQLite from "@journeyapps/wa-sqlite";

import { wrapWaSqliteDatabase, type LofiZqlSqliteDatabase } from "../zql/wa-sqlite";
import { LOFI_SQLITE_ENDPOINT_NAME, type LofiSqliteReplica } from "./replica";

/**
 * Opens replica databases in Node: one wa-sqlite module, the same SQLite build browsers run, whose
 * in-memory files every connection shares, like OPFS. Pass `open` as the replica's or the ZQL
 * host's `openDatabase` dependency.
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
    open: async ({ databaseName }: { databaseName: string }): Promise<LofiZqlSqliteDatabase> => {
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
