import {
  lofiSqliteTableName,
  quoteSqliteIdentifier,
  type LofiSqliteReader,
  type LofiSqliteReplicaOptions,
} from "@fragno-dev/lofi/sqlite";

import { automationFragmentSchema } from "../../../apps/backoffice/app/fragno/automation/schema";
import { uploadSchema } from "../../../packages/fragment-upload/src/schema";
import { backofficeViews } from "./backoffice-views";

/**
 * What an import replays the fixture into: the fixture's schema, Upload's or Automations', and
 * whether Backoffice's views are projected. Each choice has its own database.
 */
export type ImportTarget = { upload: boolean; views: boolean };

/** The kind of the read views the import worker maintains with `importReads`. */
export const IMPORT_READS = "import";

// The replica's `LofiClient` keeps its cursor under its endpoint name, "lofi-sqlite".
const CURSOR_META_KEY = "lofi-sqlite::outbox";

/** The replica options of an import, except where it streams from and where errors go. */
export function importReplica(
  target: ImportTarget,
): Pick<LofiSqliteReplicaOptions, "schemas" | "localSchemas" | "projections" | "ephemeralTables"> {
  const schema = target.upload ? uploadSchema : automationFragmentSchema;
  const local = target.views ? backofficeViews : { localSchemas: [], projections: [] };
  return {
    schemas: [{ schema }],
    localSchemas: local.localSchemas,
    projections: local.projections,
    // Older outbox entries still write these tables, which the schema removed with `noOp`, and the
    // replica rejects unknown tables of a registered schema.
    ephemeralTables: (target.upload ? [] : ["sandbox_instance", "marketplace_ingestion"]).map(
      (table) => ({ schema: schema.name, table }),
    ),
  };
}

export const importReads = {
  /** The versionstamp of the last entry the replica applied, or null before the first. */
  cursor: (reader: LofiSqliteReader) =>
    reader.query({
      sql: `SELECT "value" FROM "lofi_meta" WHERE "key" = ?1`,
      params: [CURSOR_META_KEY],
      columns: { value: "text" },
    })[0]?.value ?? null,
  /** The rows of every table the import writes. */
  tableCounts: (reader: LofiSqliteReader, target: ImportTarget) => {
    const replica = importReplica(target);
    return [...replica.schemas, ...replica.localSchemas].flatMap((registration) =>
      Object.keys(registration.schema.tables).map((table) => {
        const name = lofiSqliteTableName(registration, table);
        const { rows } = reader.query({
          sql: `SELECT count(*) AS "rows" FROM ${quoteSqliteIdentifier(name)}`,
          params: [],
          columns: { rows: "integer" },
        })[0];
        return { table: name, rows };
      }),
    );
  },
};
