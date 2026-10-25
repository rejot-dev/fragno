import { getTableForeignKey } from "@fragno-dev/db/schema";

import type { AnyLofiLocalProjection, LofiProjectionTable, LofiSchemaRegistration } from "../types";
import {
  createSqliteTableLayouts,
  createSqliteTableStatements,
  lofiSqliteTableName,
  quoteSqliteIdentifier,
  registeredSchemaName,
  type SqliteTableLayout,
} from "./layout";

/** Prefixes the `lofi_meta` key holding what a rebuildable projection's tables were built by. */
export const PROJECTION_META_KEY_PREFIX = "projection:";

/** A projection the replica rebuilds from its stored rows when `fingerprint` changes. */
export type ProjectionRebuildPlan = {
  projection: AnyLofiLocalProjection;
  metaKey: string;
  /** The version, the source tables, and the statements that create the projection's tables. */
  fingerprint: string;
  /**
   * Source tables, with the schema name the replica registered them under, and the query that
   * reads the next page of their stored rows after an internal id.
   */
  from: Array<{ schemaName: string; layout: SqliteTableLayout; nextPage: string }>;
  writes: Array<{ registration: LofiSchemaRegistration; layout: SqliteTableLayout }>;
};

type ReplicaRegistrations = {
  schemas: readonly LofiSchemaRegistration[];
  localSchemas: readonly LofiSchemaRegistration[];
  projections: readonly AnyLofiLocalProjection[];
};

/**
 * Checks every rebuildable projection's declaration: it has a unique name, replays source tables,
 * and alone writes local tables.
 */
export function planProjectionRebuilds(options: ReplicaRegistrations): ProjectionRebuildPlan[] {
  const sources = registrationTables(options.schemas);
  const locals = registrationTables(options.localSchemas);
  const names = new Set<string>();
  const owners = new Map<SqliteTableLayout, string>();

  return options.projections.flatMap((projection) => {
    const { rebuild, name } = projection;
    if (!rebuild) {
      return [];
    }
    if (!name) {
      throw new Error("A rebuildable projection needs a name.");
    }
    if (names.has(name)) {
      throw new Error(`Rebuildable projection names must be unique: ${name}`);
    }
    names.add(name);

    const from = rebuild.from.map((table) => {
      const { registration, layout } = findTable(sources, table, name, "replays");
      return {
        schemaName: registeredSchemaName(registration),
        layout,
        nextPage: nextPageQuery(registration, layout),
      };
    });
    const writes = rebuild.writes.map((table) => {
      const found = findTable(locals, table, name, "writes");
      const owner = owners.get(found.layout);
      if (owner !== undefined) {
        throw new Error(
          `Projections ${owner} and ${name} both write ${found.layout.sqlName}; a rebuild of one would empty the other's rows.`,
        );
      }
      owners.set(found.layout, name);
      return found;
    });

    return [
      {
        projection,
        metaKey: `${PROJECTION_META_KEY_PREFIX}${name}`,
        fingerprint: JSON.stringify({
          version: rebuild.version,
          from: from.map(({ layout }) => layout.sqlName),
          tables: writes.flatMap(({ registration, layout }) =>
            createSqliteTableStatements(registration, layout),
          ),
        }),
        from,
        writes,
      },
    ];
  });
}

/**
 * The registrations that name a replica's database: every source schema, and the local schemas
 * that a projection the replica cannot rebuild writes. Changing a rebuildable projection keeps the
 * database and its downloaded rows.
 */
export function registrationsNamingReplica(
  options: ReplicaRegistrations,
): LofiSchemaRegistration[] {
  const rebuilt = new Set(
    planProjectionRebuilds(options).flatMap(({ writes }) =>
      writes.map(({ layout }) => layout.table),
    ),
  );
  return [
    ...options.schemas,
    ...options.localSchemas.filter((registration) =>
      Object.values(registration.schema.tables).some((table) => !rebuilt.has(table)),
    ),
  ];
}

/** A rebuild replays a source table's stored rows this many at a time. */
const REBUILD_PAGE_ROWS = 500;

/**
 * Reads the stored rows after an internal id, in the order the replica stored them, with each
 * reference as the referenced row's external id, as the outbox sends it. A reference the replica
 * stored as NULL, because it did not hold the row, stays NULL.
 */
function nextPageQuery(registration: LofiSchemaRegistration, layout: SqliteTableLayout): string {
  const columns = Object.values(layout.table.columns).map((column) => {
    const name = quoteSqliteIdentifier(column.name);
    if (column.role !== "reference") {
      return `"row".${name}`;
    }
    const referenced = getTableForeignKey(layout.table, column.name)!.referencedTable;
    return `(SELECT ${quoteSqliteIdentifier(referenced.getIdColumn().name)} FROM ${quoteSqliteIdentifier(
      lofiSqliteTableName(registration, referenced.name),
    )} WHERE ${quoteSqliteIdentifier(referenced.getInternalIdColumn().name)} = "row".${name}) AS ${name}`;
  });
  const internalId = `"row".${quoteSqliteIdentifier(layout.table.getInternalIdColumn().name)}`;
  return `SELECT ${columns.join(", ")} FROM ${quoteSqliteIdentifier(layout.sqlName)} AS "row" WHERE ${internalId} > ? ORDER BY ${internalId} LIMIT ${REBUILD_PAGE_ROWS}`;
}

type RegistrationTables = Map<
  string,
  { registration: LofiSchemaRegistration; layouts: Map<string, SqliteTableLayout> }
>;

function registrationTables(registrations: readonly LofiSchemaRegistration[]): RegistrationTables {
  return new Map(
    registrations.map((registration) => [
      registration.schema.name,
      { registration, layouts: createSqliteTableLayouts(registration) },
    ]),
  );
}

function findTable(
  tables: RegistrationTables,
  { schema, table }: LofiProjectionTable,
  projectionName: string,
  use: "replays" | "writes",
): { registration: LofiSchemaRegistration; layout: SqliteTableLayout } {
  const registered = tables.get(schema.name);
  const layout = registered?.layouts.get(table);
  if (!registered || !layout) {
    const kind = use === "replays" ? "source" : "local";
    throw new Error(
      `Projection ${projectionName} ${use} ${schema.name}.${table}, which is not a registered ${kind} table.`,
    );
  }
  return { registration: registered.registration, layout };
}
