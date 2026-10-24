import * as SQLite from "@journeyapps/wa-sqlite";

import type { LofiSqliteReplicaOptions } from "../sqlite/replica";
import { serveLofiZql, type LofiZqlHost } from "./host";
import type { LofiZqlPort } from "./protocol";
import { wrapWaSqliteDatabase, type LofiZqlSqliteDatabase } from "./wa-sqlite";

const VFS_NAME = "lofi-zql-opfs";
const OPEN_ATTEMPTS = 3;
const OPEN_RETRY_DELAY_MS = 50;

/**
 * Serves the page that started this dedicated worker: opens the replica in OPFS, which only
 * dedicated workers can access synchronously, and maintains the page's ZQL views.
 */
export function serveLofiZqlWorker(options: LofiSqliteReplicaOptions): Promise<LofiZqlHost> {
  return serveLofiZql({
    replica: options,
    port: globalThis as unknown as LofiZqlPort,
    openDatabase: openOpfsDatabase,
  });
}

async function openOpfsDatabase(options: { databaseName: string }): Promise<LofiZqlSqliteDatabase> {
  const [{ default: SQLiteESMFactory }, { OPFSCoopSyncVFS }] = await Promise.all([
    import("@journeyapps/wa-sqlite/dist/wa-sqlite.mjs"),
    import("@journeyapps/wa-sqlite/src/examples/OPFSCoopSyncVFS.js"),
  ]);
  const module = await SQLiteESMFactory();
  const sqlite3 = SQLite.Factory(module);
  for (let attempt = 1; ; attempt++) {
    try {
      const vfs = await OPFSCoopSyncVFS.create(VFS_NAME, module);
      sqlite3.vfs_register(vfs, false);
      const db = await sqlite3.open_v2(
        options.databaseName,
        SQLite.SQLITE_OPEN_CREATE | SQLite.SQLITE_OPEN_READWRITE,
        VFS_NAME,
      );
      return wrapWaSqliteDatabase({
        module,
        sqlite3,
        db,
        close: async () => {
          await sqlite3.close(db);
          await vfs.close();
        },
      });
    } catch (error) {
      // Every OPFSCoopSyncVFS deletes the temporary directories closed workers left, and loses the
      // race when another worker deletes one first; see the README.
      if (
        attempt === OPEN_ATTEMPTS ||
        !(error instanceof DOMException) ||
        error.name !== "NotFoundError"
      ) {
        throw error;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, OPEN_RETRY_DELAY_MS * attempt);
      });
    }
  }
}
