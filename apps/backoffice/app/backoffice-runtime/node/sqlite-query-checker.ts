import { DatabaseSync } from "node:sqlite";

import type {
  SqlQuery,
  SqlQueryCheck,
} from "../../../workers/lib/backoffice-object-implementation";

/**
 * Runs each query on its own in-memory database, which `schema` creates and the check discards.
 * Node's SQLite binds the values by position, as pages number them (`?1`, `?2`, ...).
 */
export function checkSqliteQueries(
  schema: readonly string[],
  queries: readonly SqlQuery[],
): Promise<SqlQueryCheck[]> {
  return Promise.resolve(
    queries.map((query): SqlQueryCheck => {
      const database = new DatabaseSync(":memory:");
      try {
        database.exec(schema.join(";\n"));
        try {
          const statement = database.prepare(query.sql);
          // Integers beyond JavaScript's safe range otherwise fail the check, which wants only the
          // columns; the browser's replica reads them as bigints.
          statement.setReadBigInts(true);
          statement.all(...query.params);
          return { kind: "ran", columns: statement.columns().map((column) => column.name) };
        } catch (error) {
          return {
            kind: "failed",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      } finally {
        database.close();
      }
    }),
  );
}
