import { quoteSqliteIdentifier, type LofiSqliteReader } from "@fragno-dev/lofi/sqlite";

/** The kind of the read views the replica worker maintains with `replicaReads`. */
export const REPLICA_READS = "example-reads";

export const replicaReads = {
  /** Every table of the replica, with its row count. */
  tables: (reader: LofiSqliteReader) =>
    reader
      .query({
        sql: `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`,
        params: [],
        columns: { name: "text" },
      })
      .map(({ name }) => ({
        name,
        rows: reader.query({
          sql: `SELECT count(*) AS "rows" FROM ${quoteSqliteIdentifier(name)}`,
          params: [],
          columns: { rows: "integer" },
        })[0].rows,
      })),
};
