import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import type { AuthDatabase } from "./auth.do";

export function createInMemoryAuthDatabase(): Kysely<AuthDatabase> {
  const database = new Database(":memory:");
  database.function("unixepoch", () => Math.floor(Date.now() / 1_000));
  return new Kysely<AuthDatabase>({
    dialect: new SqliteDialect({ database }),
  });
}
