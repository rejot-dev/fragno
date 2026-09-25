import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import type { AuthDatabase } from "../../../workers/auth.do";
import { configureBackofficeSqliteConnection } from "./sqlite-connection-config";

/** Creates the file-backed auth database using the owning local runtime's logical clock. */
export function createSqliteAuthDatabase(
  directory: string,
  nowEpochMs: () => number,
): Kysely<AuthDatabase> {
  mkdirSync(directory, { recursive: true });
  const database = new Database(path.join(directory, "auth.sqlite"));
  configureBackofficeSqliteConnection(database);
  database.function("unixepoch", () => Math.floor(nowEpochMs() / 1_000));
  return new Kysely<AuthDatabase>({ dialect: new SqliteDialect({ database }) });
}
