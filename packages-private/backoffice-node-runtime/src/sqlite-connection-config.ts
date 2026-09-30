import Database from "better-sqlite3";

/** Applies the durable file-backed SQLite settings shared by every Node Backoffice database. */
export function configureBackofficeSqliteConnection(database: Database.Database): void {
  const journalMode = database.pragma("journal_mode = WAL", { simple: true }) as string;
  if (journalMode !== "wal") {
    throw new Error(
      `BACKOFFICE_SQLITE_WAL_UNAVAILABLE: expected journal_mode=wal, received ${journalMode}`,
    );
  }

  database.pragma("synchronous = FULL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.pragma("wal_autocheckpoint = 1000");
}
