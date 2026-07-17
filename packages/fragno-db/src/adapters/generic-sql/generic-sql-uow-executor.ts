import superjson from "superjson";

import { isRetryableDatabaseError, isUniqueConstraintError } from "../../errors";
import { SETTINGS_NAMESPACE, internalSchema } from "../../fragments/internal-fragment.schema";
import { createId } from "../../id";
import { type SqlNamingStrategy } from "../../naming/sql-naming";
import {
  type OutboxConfig,
  type OutboxRefLookup,
  type OutboxRefMap,
  encodeVersionstamp,
  parseOutboxVersionValue,
  versionstampToHex,
} from "../../outbox/outbox";
import { buildOutboxPlan, finalizeOutboxPayload } from "../../outbox/outbox-builder";
import { createSQLSerializer } from "../../query/serialize/create-sql-serializer";
import type {
  CompiledMutation,
  MutationResult,
  UOWExecutor,
} from "../../query/unit-of-work/unit-of-work";
import { sql } from "../../sql-driver/sql";
import type { CompiledQuery, Dialect } from "../../sql-driver/sql-driver";
import type { SqlDriverAdapter } from "../../sql-driver/sql-driver-adapter";
import type { DriverConfig } from "./driver-config";
import { createColdKysely } from "./migration/cold-kysely";
import { ResultInterpreter } from "./result-interpreter";

export interface ExecutorOptions {
  dryRun?: boolean;
  dialect: Dialect;
  outbox?: OutboxConfig;
  namingStrategy?: SqlNamingStrategy;
}

class SqlVersionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlVersionConflictError";
  }
}

export async function executeRetrieval(
  adapter: SqlDriverAdapter,
  retrievalBatch: CompiledQuery[],
): Promise<unknown[]> {
  if (retrievalBatch.length === 0) {
    return [];
  }

  const retrievalResults: unknown[] = [];

  await adapter.transaction(async (tx) => {
    for (const compiledQuery of retrievalBatch) {
      const result = await tx.executeQuery(compiledQuery);
      retrievalResults.push(result.rows);
    }
  });

  return retrievalResults;
}

export async function executeMutation(
  adapter: SqlDriverAdapter,
  driverConfig: DriverConfig,
  mutationBatch: CompiledMutation<CompiledQuery>[],
  options: ExecutorOptions,
): Promise<MutationResult> {
  if (mutationBatch.length === 0) {
    return { success: true, createdInternalIds: [] };
  }

  const createdInternalIds: (bigint | null)[] = [];
  const resultInterpreter = new ResultInterpreter(driverConfig);
  const outboxEnabled = options.outbox?.enabled ?? false;
  const shouldInclude = options.outbox?.shouldInclude;
  const namingStrategy = options.namingStrategy ?? driverConfig.defaultNamingStrategy;

  const outboxOperations = outboxEnabled
    ? mutationBatch.flatMap((mutation) => {
        const operation = mutation.operation;
        if (!operation) {
          return [];
        }
        if (shouldInclude && !shouldInclude(operation)) {
          return [];
        }
        return [mutation.materializedOperation ?? operation];
      })
    : [];

  const outboxPlan = outboxOperations.length > 0 ? buildOutboxPlan(outboxOperations) : null;
  const shouldWriteOutbox = outboxEnabled && outboxPlan !== null && outboxPlan.drafts.length > 0;

  try {
    await adapter.transaction(async (tx) => {
      let outboxReservation: ReservedOutboxVersion | null = null;

      if (shouldWriteOutbox) {
        outboxReservation = await reserveOutboxVersion(tx, driverConfig, options.dialect);
      }

      for (const compiledMutation of mutationBatch) {
        let result: Awaited<ReturnType<typeof tx.executeQuery>>;
        try {
          result = await tx.executeQuery(compiledMutation.query);
        } catch (error) {
          const operation = compiledMutation.operation;
          if (
            (operation?.type === "create" || operation?.type === "update") &&
            operation.retryOnUniqueConflict
          ) {
            const normalizedError = driverConfig.normalizeError(error);
            if (
              isUniqueConstraintError(normalizedError) &&
              operation.retryOnUniqueConflict({
                error: normalizedError,
                operation: {
                  type: operation.type,
                  schema: operation.schema.name,
                  namespace: operation.namespace ?? null,
                  table: operation.table,
                },
              })
            ) {
              throw new SqlVersionConflictError("Retryable unique mutation conflict detected.");
            }
            throw normalizedError;
          }
          throw error;
        }

        // Extract internal ID for INSERT operations
        if (compiledMutation.op === "create") {
          // Only try to extract internal ID if driver supports RETURNING
          // If not supported, push null (expected case - system falls back to subqueries)
          if (driverConfig.supportsReturning && driverConfig.internalIdColumn) {
            const internalId = resultInterpreter.getCreatedInternalId(result);
            createdInternalIds.push(internalId);
          } else {
            // Driver doesn't support RETURNING - this is expected, push null
            createdInternalIds.push(null);
          }
        } else if (
          (compiledMutation.op === "update" || compiledMutation.op === "delete") &&
          compiledMutation.expectedAffectedRows !== null
        ) {
          // Check affected rows for updates/deletes
          const affectedRows = resultInterpreter.getAffectedRows(result);

          if (affectedRows !== compiledMutation.expectedAffectedRows) {
            // Version conflict detected - the UPDATE/DELETE didn't affect the expected number of rows
            // This means either the row doesn't exist or the version has changed
            throw new SqlVersionConflictError(
              `Version conflict: expected ${compiledMutation.expectedAffectedRows} rows affected, but got ${affectedRows}`,
            );
          }
        }
        // "check" operations are handled below via expectedReturnedRows

        if (compiledMutation.expectedReturnedRows !== null) {
          // For SELECT queries (check operations), verify row count
          const returnedRowCount = resultInterpreter.getReturnedRowCount(result);

          if (returnedRowCount !== BigInt(compiledMutation.expectedReturnedRows)) {
            // Version conflict detected - the SELECT didn't return the expected number of rows
            // This means either the row doesn't exist or the version has changed
            throw new SqlVersionConflictError(
              `Version conflict: expected ${compiledMutation.expectedReturnedRows} rows returned, but got ${returnedRowCount}`,
            );
          }
        }
      }

      if (shouldWriteOutbox && outboxPlan && outboxReservation !== null) {
        const uowId = mutationBatch[0]?.uowId;
        if (!uowId) {
          throw new Error("Outbox mutation batch is missing uowId.");
        }

        const refMap = await resolveOutboxRefMap(
          tx,
          driverConfig,
          outboxPlan.lookups,
          namingStrategy,
        );
        const payload = finalizeOutboxPayload(outboxPlan, outboxReservation.version, {
          now: outboxReservation.now,
        });
        const payloadSerialized = superjson.serialize(payload);
        const versionstamp = versionstampToHex(encodeVersionstamp(outboxReservation.version, 0));

        await insertOutboxMutationRows(tx, driverConfig, {
          entryVersionstamp: versionstamp,
          uowId,
          mutations: payload.mutations,
        });
        await insertOutboxRow(tx, driverConfig, {
          id: createId(),
          versionstamp,
          uowId,
          payload: payloadSerialized,
          refMap,
        });
      }
    });

    return { success: true, createdInternalIds };
  } catch (error) {
    // Transaction failed - could be version conflict or other constraint violation
    // Return success=false to indicate the UOW should be retried
    if (error instanceof SqlVersionConflictError) {
      return { success: false };
    }

    const normalizedError = driverConfig.normalizeError(error);
    if (isRetryableDatabaseError(normalizedError)) {
      return { success: false };
    }

    // Other database errors should be normalized and thrown for callers to map.
    throw normalizedError;
  }
}

export function createExecutor(
  adapter: SqlDriverAdapter,
  driverConfig: DriverConfig,
  options: ExecutorOptions,
): UOWExecutor<CompiledQuery> {
  const dryRun = options.dryRun ?? false;

  return {
    async executeRetrievalPhase(retrievalBatch: CompiledQuery[]) {
      // In dryRun mode, skip execution and return empty results
      if (dryRun) {
        return retrievalBatch.map(() => []);
      }

      return executeRetrieval(adapter, retrievalBatch);
    },
    async executeMutationPhase(mutationBatch: CompiledMutation<CompiledQuery>[]) {
      // In dryRun mode, skip execution and return success with mock internal IDs
      if (dryRun) {
        return {
          success: true,
          createdInternalIds: mutationBatch.map(() => null),
        };
      }

      return executeMutation(adapter, driverConfig, mutationBatch, options);
    },
  };
}

type ReservedOutboxVersion = {
  version: bigint;
  now: Date;
};

async function reserveOutboxVersion(
  tx: SqlDriverAdapter,
  driverConfig: DriverConfig,
  dialect: Dialect,
): Promise<ReservedOutboxVersion> {
  const key = `${SETTINGS_NAMESPACE}.outbox_version`;
  const id = createId();

  switch (driverConfig.outboxVersionstampStrategy) {
    case "insert-on-conflict-returning": {
      const query =
        driverConfig.databaseType === "postgresql"
          ? sql`
              insert into fragno_db_settings (id, key, value)
              values (${id}, ${key}, '0')
              on conflict (key) do update
                set value = (fragno_db_settings.value::bigint + 1)::text
              returning value, floor(extract(epoch from CURRENT_TIMESTAMP) * 1000)::bigint as "nowMs";
            `
          : sql`
              insert into fragno_db_settings (id, key, value)
              values (${id}, ${key}, '0')
              on conflict (key) do update
                set value = cast(fragno_db_settings.value as integer) + 1
              returning value, cast((julianday('now') - 2440587.5) * 86400000 as integer) as nowMs;
            `;

      const result = await tx.executeQuery(query.compile(dialect));
      return parseReservedOutboxVersion(result.rows[0]);
    }
    case "update-returning": {
      const query =
        driverConfig.databaseType === "postgresql"
          ? sql`
              update fragno_db_settings
              set value = (fragno_db_settings.value::bigint + 1)::text
              where key = ${key}
              returning value, floor(extract(epoch from CURRENT_TIMESTAMP) * 1000)::bigint as "nowMs";
            `
          : sql`
              update fragno_db_settings
              set value = cast(fragno_db_settings.value as integer) + 1
              where key = ${key}
              returning value, cast((julianday('now') - 2440587.5) * 86400000 as integer) as nowMs;
            `;

      const result = await tx.executeQuery(query.compile(dialect));
      if (result.rows[0]?.["value"] === undefined) {
        throw new Error("Outbox version row was not found for update-returning strategy.");
      }
      return parseReservedOutboxVersion(result.rows[0]);
    }
    case "insert-on-duplicate-last-insert-id": {
      const insertQuery = sql`
        insert into fragno_db_settings (id, key, value)
        values (${id}, ${key}, LAST_INSERT_ID(0))
        on duplicate key update value = LAST_INSERT_ID(cast(value as unsigned) + 1);
      `;

      await tx.executeQuery(insertQuery.compile(dialect));

      const selectQuery = sql`
        select LAST_INSERT_ID() as value,
          cast(unix_timestamp(current_timestamp(3)) * 1000 as unsigned) as nowMs;
      `;
      const result = await tx.executeQuery(selectQuery.compile(dialect));
      return parseReservedOutboxVersion(result.rows[0]);
    }
  }

  throw new Error("Unsupported outbox versionstamp strategy.");
}

function parseReservedOutboxVersion(
  row: Record<string, unknown> | undefined,
): ReservedOutboxVersion {
  const value = row?.["value"];
  const nowMs = row?.["nowMs"] ?? row?.["nowms"];

  if (typeof nowMs !== "number" && typeof nowMs !== "bigint" && typeof nowMs !== "string") {
    throw new Error(`Invalid outbox reservation timestamp: ${String(nowMs)}`);
  }

  return {
    version: parseOutboxVersionValue(value),
    now: new Date(Number(nowMs)),
  };
}

async function resolveOutboxRefMap(
  tx: SqlDriverAdapter,
  driverConfig: DriverConfig,
  lookups: OutboxRefLookup[],
  namingStrategy: SqlNamingStrategy,
): Promise<OutboxRefMap | undefined> {
  if (lookups.length === 0) {
    return undefined;
  }

  const refMap: OutboxRefMap = {};
  const db = createColdKysely(driverConfig.databaseType);

  for (const lookup of lookups) {
    const namespace = lookup.namespace ?? null;
    const logicalTable = lookup.table.name;
    const schemaName =
      namingStrategy.namespaceScope === "schema" && namespace && namespace.length > 0
        ? namingStrategy.namespaceToSchema(namespace)
        : null;
    const scopedDb = schemaName ? db.withSchema(schemaName) : db;
    const tableName = namingStrategy.tableName(logicalTable, namespace);
    const internalColumn = namingStrategy.columnName(
      lookup.table.getInternalIdColumn().name,
      logicalTable,
    );
    const externalColumn = namingStrategy.columnName(lookup.table.getIdColumn().name, logicalTable);

    const query = scopedDb
      .selectFrom(tableName)
      .select(externalColumn)
      .where(internalColumn, "=", lookup.internalId)
      .compile();

    const result = await tx.executeQuery(query);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    const externalId = row?.[externalColumn];

    if (typeof externalId !== "string") {
      throw new Error(
        `Failed to resolve outbox reference for ${tableName}.${internalColumn}=${String(lookup.internalId)}`,
      );
    }

    refMap[lookup.key] = externalId;
  }

  return Object.keys(refMap).length > 0 ? refMap : undefined;
}

async function insertOutboxRow(
  tx: SqlDriverAdapter,
  driverConfig: DriverConfig,
  options: {
    id: string;
    versionstamp: string;
    uowId: string;
    payload: { json: unknown; meta?: Record<string, unknown> };
    refMap?: OutboxRefMap;
  },
): Promise<void> {
  const { id, versionstamp, uowId, payload, refMap } = options;
  const refMapValue = refMap ?? null;
  const serializer = createSQLSerializer(driverConfig);
  const outboxTable = internalSchema.tables.fragno_db_outbox;
  const values = { id, versionstamp, uowId, payload, refMap: refMapValue };
  const serializedValues: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const col = outboxTable.getColumnByName(key);
    if (!col) {
      serializedValues[key] = value;
      continue;
    }
    serializedValues[col.name] = serializer.serialize(value, col);
  }
  const db = createColdKysely(driverConfig.databaseType);

  const query = db.insertInto("fragno_db_outbox").values(serializedValues).compile();

  await tx.executeQuery(query);
}

async function insertOutboxMutationRows(
  tx: SqlDriverAdapter,
  driverConfig: DriverConfig,
  options: {
    entryVersionstamp: string;
    uowId: string;
    mutations: {
      versionstamp: string;
      schema: string;
      table: string;
      externalId: string;
      op: string;
    }[];
  },
): Promise<void> {
  if (options.mutations.length === 0) {
    return;
  }

  const serializer = createSQLSerializer(driverConfig);
  const mutationsTable = internalSchema.tables.fragno_db_outbox_mutations;
  const db = createColdKysely(driverConfig.databaseType);

  for (const mutation of options.mutations) {
    const values = {
      id: createId(),
      entryVersionstamp: options.entryVersionstamp,
      mutationVersionstamp: mutation.versionstamp,
      uowId: options.uowId,
      schema: mutation.schema,
      table: mutation.table,
      externalId: mutation.externalId,
      op: mutation.op,
    };
    const serializedValues: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(values)) {
      const col = mutationsTable.getColumnByName(key);
      if (!col) {
        serializedValues[key] = value;
        continue;
      }
      serializedValues[col.name] = serializer.serialize(value, col);
    }

    const query = db.insertInto("fragno_db_outbox_mutations").values(serializedValues).compile();
    await tx.executeQuery(query);
  }
}
