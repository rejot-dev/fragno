import { sql, type RawBuilder, type SelectQueryBuilder } from "kysely";

import { internalSchema } from "../../fragments/internal-fragment.schema";
import { createNamingResolver, type SqlNamingStrategy } from "../../naming/sql-naming";
import type { OutboxStreamOptions, SerializedOutboxStreamEntry } from "../../outbox/outbox-stream";
import { assembleSerializedOutboxStreamEntry } from "../../outbox/serialized-outbox-stream-entry";
import type { SqlDriverAdapter } from "../../sql-driver/sql-driver-adapter";
import type { DriverConfig } from "./driver-config";
import { createColdKysely } from "./migration/cold-kysely";

const FRAGNO_SQL_STREAM_CHUNK_SIZE = 50;
const OUTBOX_ENTRY_ALIAS = "_fragno_outbox_stream_entry";
const OUTBOX_MUTATION_ALIAS = "_fragno_outbox_stream_mutation";
const OUTBOX_MUTATION_ITEM_ALIAS = "_fragno_outbox_stream_item";
const OUTBOX_MUTATION_AGGREGATE_ALIAS = "_fragno_outbox_stream_aggregate";

type SerializedOutboxDatabaseRow = {
  versionstamp: string;
  uowId: string;
  refMapJson: string | null;
  mutationPayloadsJson: string;
};

function projectJsonColumnAsText(
  value: RawBuilder<unknown>,
  driverConfig: DriverConfig,
): RawBuilder<string> {
  return driverConfig.databaseType === "mysql"
    ? sql<string>`cast(${value} as char)`
    : sql<string>`cast(${value} as text)`;
}

function aggregateMutationPayloadsAsJson<
  TDatabase,
  TTable extends keyof TDatabase & string,
  TOutput,
>(
  mutationQuery: SelectQueryBuilder<TDatabase, TTable, TOutput>,
  driverConfig: DriverConfig,
): RawBuilder<string> {
  const item = sql.ref(`${OUTBOX_MUTATION_AGGREGATE_ALIAS}.${OUTBOX_MUTATION_ITEM_ALIAS}`);
  let aggregate: RawBuilder<unknown>;
  switch (driverConfig.databaseType) {
    case "sqlite":
      aggregate = sql`
        coalesce(
          (
            select json_group_array(json(${item}))
            from (${mutationQuery}) as ${sql.ref(OUTBOX_MUTATION_AGGREGATE_ALIAS)}
          ),
          json('[]')
        )
      `;
      break;
    case "postgresql":
      aggregate = sql`
        coalesce(
          (
            select json_agg(${item})
            from (${mutationQuery}) as ${sql.ref(OUTBOX_MUTATION_AGGREGATE_ALIAS)}
          ),
          '[]'::json
        )
      `;
      break;
    case "mysql":
      aggregate = sql`
        coalesce(
          (
            select json_arrayagg(${item})
            from (${mutationQuery}) as ${sql.ref(OUTBOX_MUTATION_AGGREGATE_ALIAS)}
          ),
          json_array()
        )
      `;
      break;
  }
  return projectJsonColumnAsText(aggregate, driverConfig);
}

/** Streams bounded SQL outbox rows without parsing their stored mutation payload JSON. */
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
  const mutationPayload = sql.ref(`${OUTBOX_MUTATION_ALIAS}.${mutationPayloadColumn}`);
  const mutationItem =
    driverConfig.databaseType === "mysql"
      ? sql`json_array(
          row_number() over (
            order by ${sql.ref(`${OUTBOX_MUTATION_ALIAS}.${mutationVersionstampColumn}`)} asc
          ),
          ${mutationPayload}
        )`
      : mutationPayload;
  const mutationQuery = database
    .selectFrom(`${mutationTableName} as ${OUTBOX_MUTATION_ALIAS}`)
    .select(mutationItem.as(OUTBOX_MUTATION_ITEM_ALIAS))
    .whereRef(
      `${OUTBOX_MUTATION_ALIAS}.${mutationEntryVersionstampColumn}`,
      "=",
      `${OUTBOX_ENTRY_ALIAS}.${versionstampColumn}`,
    )
    .orderBy(`${OUTBOX_MUTATION_ALIAS}.${mutationVersionstampColumn}`, "asc");
  const mutationPayloadsJson = aggregateMutationPayloadsAsJson(mutationQuery, driverConfig);

  let query = database
    .selectFrom(`${outboxTableName} as ${OUTBOX_ENTRY_ALIAS}`)
    .select([
      sql.ref(`${OUTBOX_ENTRY_ALIAS}.${versionstampColumn}`).as("versionstamp"),
      sql.ref(`${OUTBOX_ENTRY_ALIAS}.${uowIdColumn}`).as("uowId"),
      projectJsonColumnAsText(sql.ref(`${OUTBOX_ENTRY_ALIAS}.${refMapColumn}`), driverConfig).as(
        "refMapJson",
      ),
      mutationPayloadsJson.as("mutationPayloadsJson"),
    ])
    .orderBy(`${OUTBOX_ENTRY_ALIAS}.${versionstampColumn}`, "asc")
    .limit(streamOptions.limit);

  if (streamOptions.afterVersionstamp !== undefined) {
    query = query.where(
      `${OUTBOX_ENTRY_ALIAS}.${versionstampColumn}`,
      ">",
      streamOptions.afterVersionstamp.toLowerCase(),
    );
  }

  const compiledQuery = query.compile();
  const serializeRow = (row: Record<string, unknown>): SerializedOutboxStreamEntry => {
    const stored = row as SerializedOutboxDatabaseRow;
    return assembleSerializedOutboxStreamEntry({
      ...stored,
      mysqlOrdinalWrapped: driverConfig.databaseType === "mysql",
    });
  };

  if (driverConfig.retrievalExecution.kind === "buffered-page") {
    const result = await driver.executeQuery(compiledQuery);
    for (const row of result.rows) {
      yield serializeRow(row);
    }
    return;
  }

  for await (const chunk of driver.streamQuery(compiledQuery, FRAGNO_SQL_STREAM_CHUNK_SIZE)) {
    for (const row of chunk.rows) {
      yield serializeRow(row);
    }
  }
}
