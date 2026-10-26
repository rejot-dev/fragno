import { sql, type RawBuilder } from "kysely";

import { internalSchema } from "../../fragments/internal-fragment.schema";
import { createNamingResolver, type SqlNamingStrategy } from "../../naming/sql-naming";
import type { OutboxStreamOptions, SerializedOutboxStreamEntry } from "../../outbox/outbox-stream";
import { assembleSerializedOutboxStreamEntry } from "../../outbox/serialized-outbox-stream-entry";
import type { SqlDriverAdapter } from "../../sql-driver/sql-driver-adapter";
import type { DriverConfig } from "./driver-config";
import { createColdKysely } from "./migration/cold-kysely";

const OUTBOX_ENTRY_ALIAS = "_fragno_outbox_stream_entry";
const OUTBOX_MUTATION_ALIAS = "_fragno_outbox_stream_mutation";

type OutboxEntryRow = {
  versionstamp: string;
  uowId: string;
  refMapJson: string | null;
};

type OutboxMutationRow = {
  entryVersionstamp: string;
  payloadJson: string;
};

function projectJsonColumnAsText(
  value: RawBuilder<unknown>,
  driverConfig: DriverConfig,
): RawBuilder<string> {
  return driverConfig.databaseType === "mysql"
    ? sql<string>`cast(${value} as char)`
    : sql<string>`cast(${value} as text)`;
}

/**
 * Streams one bounded page of SQL outbox rows without parsing their stored mutation payload JSON.
 *
 * A page is two queries: its entries, then the mutations of the versionstamp range they span, as
 * stored text in order. Aggregating each entry's mutations into a JSON array in SQL instead made
 * the database parse and re-serialize every payload, and the adapter split the array again.
 */
export async function* streamSqlSerializedOutboxEntries(options: {
  driver: SqlDriverAdapter;
  driverConfig: DriverConfig;
  namingStrategy: SqlNamingStrategy;
  streamOptions: OutboxStreamOptions;
}): AsyncIterableIterator<SerializedOutboxStreamEntry> {
  const { driver, driverConfig, namingStrategy, streamOptions } = options;
  if (!Number.isSafeInteger(streamOptions.limit) || streamOptions.limit < 1) {
    throw new Error("SqlAdapter.streamSerializedOutboxEntries requires a positive limit.");
  }

  const resolver = createNamingResolver(internalSchema, null, namingStrategy);
  const outboxTable = internalSchema.tables.fragno_db_outbox;
  const mutationTable = internalSchema.tables.fragno_db_outbox_mutations;
  const outboxTableName = resolver.getTableName(outboxTable.name);
  const mutationTableName = resolver.getTableName(mutationTable.name);
  const versionstampColumn = resolver.getColumnName(outboxTable.name, "versionstamp");
  const uowIdColumn = resolver.getColumnName(outboxTable.name, "uowId");
  const refMapColumn = resolver.getColumnName(outboxTable.name, "refMap");
  const mutationEntryVersionstampColumn = resolver.getColumnName(
    mutationTable.name,
    "entryVersionstamp",
  );
  const mutationVersionstampColumn = resolver.getColumnName(
    mutationTable.name,
    "mutationVersionstamp",
  );
  const mutationPayloadColumn = resolver.getColumnName(mutationTable.name, "payload");
  const database = createColdKysely(driverConfig.databaseType);

  let entryQuery = database
    .selectFrom(`${outboxTableName} as ${OUTBOX_ENTRY_ALIAS}`)
    .select([
      sql.ref(`${OUTBOX_ENTRY_ALIAS}.${versionstampColumn}`).as("versionstamp"),
      sql.ref(`${OUTBOX_ENTRY_ALIAS}.${uowIdColumn}`).as("uowId"),
      projectJsonColumnAsText(sql.ref(`${OUTBOX_ENTRY_ALIAS}.${refMapColumn}`), driverConfig).as(
        "refMapJson",
      ),
    ])
    .orderBy(`${OUTBOX_ENTRY_ALIAS}.${versionstampColumn}`, "asc")
    .limit(streamOptions.limit);
  if (streamOptions.afterVersionstamp !== undefined) {
    entryQuery = entryQuery.where(
      `${OUTBOX_ENTRY_ALIAS}.${versionstampColumn}`,
      ">",
      streamOptions.afterVersionstamp.toLowerCase(),
    );
  }

  // A page is bounded by its limit, so both queries are read whole rather than through a cursor.
  const entries = (await driver.executeQuery(entryQuery.compile())).rows as OutboxEntryRow[];
  const firstEntry = entries[0];
  const lastEntry = entries.at(-1);
  if (firstEntry === undefined || lastEntry === undefined) {
    return;
  }

  const mutationEntryVersionstamp = `${OUTBOX_MUTATION_ALIAS}.${mutationEntryVersionstampColumn}`;
  const mutationQuery = database
    .selectFrom(`${mutationTableName} as ${OUTBOX_MUTATION_ALIAS}`)
    .select([
      sql.ref(mutationEntryVersionstamp).as("entryVersionstamp"),
      projectJsonColumnAsText(
        sql.ref(`${OUTBOX_MUTATION_ALIAS}.${mutationPayloadColumn}`),
        driverConfig,
      ).as("payloadJson"),
    ])
    .where(mutationEntryVersionstamp, ">=", firstEntry.versionstamp)
    .where(mutationEntryVersionstamp, "<=", lastEntry.versionstamp)
    .orderBy(mutationEntryVersionstamp, "asc")
    .orderBy(`${OUTBOX_MUTATION_ALIAS}.${mutationVersionstampColumn}`, "asc");
  const mutations = (await driver.executeQuery(mutationQuery.compile()))
    .rows as OutboxMutationRow[];

  // An entry committed late can fall inside the range without being on this page; its mutations
  // are left for the page that holds it.
  const payloadsByEntry = new Map<string, string[]>(
    entries.map((entry) => [entry.versionstamp, []]),
  );
  for (const mutation of mutations) {
    payloadsByEntry.get(mutation.entryVersionstamp)?.push(mutation.payloadJson);
  }

  for (const entry of entries) {
    yield assembleSerializedOutboxStreamEntry({
      versionstamp: entry.versionstamp,
      uowId: entry.uowId,
      refMapJson: entry.refMapJson,
      mutationPayloads: payloadsByEntry.get(entry.versionstamp) ?? [],
    });
  }
}
