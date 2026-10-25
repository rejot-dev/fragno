import * as SQLite from "@journeyapps/wa-sqlite";

import { serveLofiSqlite, type LofiSqliteHost } from "./host";
import type { LofiSqlitePort } from "./protocol";
import type { LofiSqliteReplicaOptions } from "./replica";
import { wrapWaSqliteDatabase, type LofiSqliteSyncDatabase } from "./sync-connection";
import type { LofiSqliteViewEngine } from "./views";

const VFS_NAME = "lofi-sqlite-opfs";
const OPEN_ATTEMPTS = 3;
const OPEN_RETRY_DELAY_MS = 50;

const HEARTBEAT_INTERVAL_MS = 1_000;
// A hidden tab's timers may run late, so a live leader can miss beats. Taking over from it costs
// a rebuild of every view, and moves the lead to a tab whose timers run.
const LEADER_TIMEOUT_MS = 10_000;

/**
 * Serves the page that started this dedicated worker its live views. If this tab leads, the worker
 * opens the replica in OPFS, which only dedicated workers can access synchronously.
 */
export function serveLofiSqliteWorker(options: {
  replica: LofiSqliteReplicaOptions;
  /** Engines of views beyond SQL, such as `@fragno-dev/lofi-zql`'s. */
  engines: LofiSqliteViewEngine[];
}): LofiSqliteHost {
  return serveLofiSqlite({
    replica: options.replica,
    engines: options.engines,
    port: globalThis as unknown as LofiSqlitePort,
    openDatabase: openOpfsDatabase,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    leaderTimeoutMs: LEADER_TIMEOUT_MS,
  });
}

async function openOpfsDatabase(options: {
  databaseName: string;
}): Promise<LofiSqliteSyncDatabase> {
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
      // On wa-sqlite 1.x, every OPFSCoopSyncVFS deletes the temporary directories closed workers
      // left, and loses the race when another worker deletes one first; see the README. 2.x
      // ignores the directory that is already gone.
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
