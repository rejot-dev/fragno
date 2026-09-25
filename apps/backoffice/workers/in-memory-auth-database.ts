import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import type { AuthDatabase } from "./auth.do";

/** Creates the transient auth database using the owning local runtime's logical clock. */
export function createInMemoryAuthDatabase(nowEpochMs: () => number): Kysely<AuthDatabase> {
  const database = new Database(":memory:");
  database.function("unixepoch", () => Math.floor(nowEpochMs() / 1_000));
  return new Kysely<AuthDatabase>({ dialect: new SqliteDialect({ database }) });
}
