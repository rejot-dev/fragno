import type {
  CompiledMutation,
  MutationResult,
  UOWExecutor,
} from "../../query/unit-of-work/unit-of-work";
import type { CompiledQuery, Dialect } from "../../sql-driver/sql-driver";
import type { SqlDriverAdapter } from "../../sql-driver/sql-driver-adapter";
import type { DriverConfig } from "./driver-config";
import { ResultInterpreter } from "./result-interpreter";
import { sql } from "../../sql-driver/sql";
import { createId } from "../../id";
import superjson from "superjson";
import { createColdKysely } from "./migration/cold-kysely";
import { SETTINGS_NAMESPACE, internalSchema } from "../../fragments/internal-fragment.schema";
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
import { type SqlNamingStrategy } from "../../naming/sql-naming";
import { getDbNowStrategy } from "./db-now-strategy";

export interface ExecutorOptions {
  dryRun?: boolean;
  dialect: Dialect;
  outbox?: OutboxConfig;
  namingStrategy?: SqlNamingStrategy;
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
  const dbNowStrategy = getDbNowStrategy(driverConfig);

  const outboxOperations = outboxEnabled
    ? mutationBatch.flatMap((mutation) => {
        const operation = mutation.operation;
        if (!operation) {
          return [];
        }
        if (shouldInclude && !shouldInclude(operation)) {
          return [];
        }
        return [operation];
      })
    : [];

  const outboxPlan = outboxOperations.length > 0 ? buildOutboxPlan(outboxOperations) : null;
  const shouldWriteOutbox = outboxEnabled && outboxPlan !== null && outboxPlan.drafts.length > 0;

  try {
    await adapter.transaction(async (tx) => {
      let outboxVersion: bigint | null = null;

      const preludeStatements = dbNowStrategy.preludeStatements?.();
      if (preludeStatements && preludeStatements.length > 0) {
        for (const statement of preludeStatements) {
          await tx.executeQuery(statement.compile(options.dialect));
        }
      }

      if (shouldWriteOutbox) {
        outboxVersion = await reserveOutboxVersion(tx, driverConfig, options.dialect);
      }

      for (const compiledMutation of mutationBatch) {
        const result = await tx.executeQuery(compiledMutation.query);

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
            throw new Error(
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
            throw new Error(
              `Version conflict: expected ${compiledMutation.expectedReturnedRows} rows returned, but got ${returnedRowCount}`,
            );
          }
        }
      }

      if (shouldWriteOutbox && outboxPlan && outboxVersion !== null) {
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
        const payload = finalizeOutboxPayload(outboxPlan, outboxVersion);
        const payloadSerialized = superjson.serialize(payload);
        const versionstamp = versionstampToHex(encodeVersionstamp(outboxVersion, 0));

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
    if (error instanceof Error && error.message.includes("Version conflict")) {
      return { success: false };
    }

    const errorCode =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;

    if (errorCode === "40001" || errorCode === "40P01") {
      return { success: false };
    }

    // Other database errors should be thrown
    throw error;
  }
}

export function createExecutor(
  adapter: SqlDriverAdapter,
  driverConfig: DriverConfig,
  options: ExecutorOptions,
): UOWExecutor<CompiledQuery, unknown> {
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

async function reserveOutboxVersion(
  tx: SqlDriverAdapter,
  driverConfig: DriverConfig,
  dialect: Dialect,
): Promise<bigint> {
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
              returning value;
            `
          : sql`
              insert into fragno_db_settings (id, key, value)
              values (${id}, ${key}, '0')
              on conflict (key) do update
                set value = cast(fragno_db_settings.value as integer) + 1
              returning value;
            `;

      const result = await tx.executeQuery(query.compile(dialect));
      const value = result.rows[0]?.["value"];
      return parseOutboxVersionValue(value);
    }
    case "update-returning": {
      const query =
        driverConfig.databaseType === "postgresql"
          ? sql`
              update fragno_db_settings
              set value = (fragno_db_settings.value::bigint + 1)::text
              where key = ${key}
              returning value;
            `
          : sql`
              update fragno_db_settings
              set value = cast(fragno_db_settings.value as integer) + 1
              where key = ${key}
              returning value;
            `;

      const result = await tx.executeQuery(query.compile(dialect));
      const value = result.rows[0]?.["value"];
      if (value === undefined) {
        throw new Error("Outbox version row was not found for update-returning strategy.");
      }
      return parseOutboxVersionValue(value);
    }
    case "insert-on-duplicate-last-insert-id": {
      const insertQuery = sql`
        insert into fragno_db_settings (id, key, value)
        values (${id}, ${key}, LAST_INSERT_ID(0))
        on duplicate key update value = LAST_INSERT_ID(cast(value as unsigned) + 1);
      `;

      await tx.executeQuery(insertQuery.compile(dialect));

      const selectQuery = sql`select LAST_INSERT_ID() as value;`;
      const result = await tx.executeQuery(selectQuery.compile(dialect));
      const value = result.rows[0]?.["value"];
      return parseOutboxVersionValue(value);
    }
  }
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
    const col = outboxTable.columns[key];
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
      const col = mutationsTable.columns[key];
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
