import { sql } from "kysely";
import type { Condition } from "../query/condition-builder";
import type { CompiledJoin } from "../query/orm/orm";
import type { AnyTable } from "../schema/create";
import type { SqlDriverAdapter } from "../sql-driver/sql-driver-adapter";
import { createColdKysely } from "../adapters/generic-sql/migration/cold-kysely";
import { createSQLQueryCompiler } from "../adapters/generic-sql/query/create-sql-query-compiler";
import type { AnyExpressionBuilder } from "../adapters/generic-sql/query/sql-query-compiler";
import type { DriverConfig } from "../adapters/generic-sql/driver-config";
import type { SQLiteStorageMode } from "../adapters/generic-sql/sqlite-storage";
import type { NamingResolver } from "../naming/sql-naming";
import { resolveShardValue, type ShardScope, type ShardingStrategy } from "../sharding";

export type ConflictKey = {
  schema: string;
  table: string;
  externalId: string;
};

export type ConflictReadScope = {
  schema: string;
  table: AnyTable;
  indexName: string;
  condition?: Condition;
  joins?: CompiledJoin[];
};

export type UnknownRead = {
  schema: string;
  table: string;
};

export type UnknownReadStrategy = "conflict" | "table" | "ignore";

export type ConflictCheckInput = {
  baseVersionstamp?: string;
  readKeys: ConflictKey[];
  writeKeys: ConflictKey[];
  readScopes: ConflictReadScope[];
  unknownReads?: UnknownRead[];
  unknownReadStrategy?: UnknownReadStrategy;
};

export type ConflictCheckRuntime = {
  driver: SqlDriverAdapter;
  driverConfig: DriverConfig;
  sqliteStorageMode?: SQLiteStorageMode;
  resolver?: NamingResolver;
  shardingStrategy?: ShardingStrategy;
  shard?: string | null;
  shardScope?: ShardScope;
};

const OUTBOX_MUTATIONS_TABLE = "fragno_db_outbox_mutations" as const;

const shouldApplyShardFilter = (runtime: ConflictCheckRuntime): boolean =>
  runtime.shardingStrategy?.mode === "row" && (runtime.shardScope ?? "scoped") === "scoped";

const resolveShard = (runtime: ConflictCheckRuntime): string =>
  resolveShardValue(runtime.shard ?? null);

const resolveShardColumn = (runtime: ConflictCheckRuntime, tableName: string): string =>
  runtime.resolver ? runtime.resolver.getColumnName(tableName, "_shard") : "_shard";

const buildShardPredicate = (eb: AnyExpressionBuilder, columnRef: string, shard: string) =>
  eb(columnRef, "=", shard);

const normalizeKeys = (keys: ConflictKey[]): ConflictKey[] =>
  keys.filter((key) => key.externalId.trim().length > 0);

const groupKeys = (keys: ConflictKey[]) => {
  const map = new Map<string, { schema: string; table: string; externalIds: string[] }>();
  for (const key of keys) {
    const groupKey = `${key.schema}::${key.table}`;
    const existing = map.get(groupKey);
    if (existing) {
      existing.externalIds.push(key.externalId);
      continue;
    }
    map.set(groupKey, {
      schema: key.schema,
      table: key.table,
      externalIds: [key.externalId],
    });
  }
  return Array.from(map.values());
};

const groupTables = (tables: UnknownRead[]) => {
  const map = new Map<string, UnknownRead>();
  for (const entry of tables) {
    const key = `${entry.schema}::${entry.table}`;
    if (!map.has(key)) {
      map.set(key, entry);
    }
  }
  return Array.from(map.values());
};

const hasKeyConflicts = async (
  runtime: ConflictCheckRuntime,
  baseVersionstamp: string | undefined,
  readKeys: ConflictKey[],
  writeKeys: ConflictKey[],
): Promise<boolean> => {
  const combinedKeys = normalizeKeys([...readKeys, ...writeKeys]);
  if (combinedKeys.length === 0) {
    return false;
  }

  const grouped = groupKeys(combinedKeys);
  const db = createColdKysely(runtime.driverConfig.databaseType);
  let query = db.selectFrom(OUTBOX_MUTATIONS_TABLE).select(sql<number>`1`.as("exists"));
  if (shouldApplyShardFilter(runtime)) {
    const shard = resolveShard(runtime);
    query = query.where((eb) =>
      buildShardPredicate(eb, resolveShardColumn(runtime, OUTBOX_MUTATIONS_TABLE), shard),
    );
  }

  if (baseVersionstamp) {
    query = query.where("entryVersionstamp", ">", baseVersionstamp);
  }

  query = query.where((eb) =>
    eb.or(
      grouped.map((group) =>
        eb.and([
          eb("schema", "=", group.schema),
          eb("table", "=", group.table),
          eb("externalId", "in", group.externalIds),
        ]),
      ),
    ),
  );

  query = query.limit(1);

  const result = await runtime.driver.executeQuery(query.compile());
  return result.rows.length > 0;
};

const hasUnknownReadConflicts = async (
  runtime: ConflictCheckRuntime,
  baseVersionstamp: string | undefined,
  unknownReads: UnknownRead[],
  strategy: UnknownReadStrategy,
): Promise<boolean> => {
  if (unknownReads.length === 0 || strategy === "ignore") {
    return false;
  }

  const db = createColdKysely(runtime.driverConfig.databaseType);

  if (strategy === "conflict") {
    let query = db.selectFrom(OUTBOX_MUTATIONS_TABLE).select(sql<number>`1`.as("exists"));
    if (shouldApplyShardFilter(runtime)) {
      const shard = resolveShard(runtime);
      query = query.where((eb) =>
        buildShardPredicate(eb, resolveShardColumn(runtime, OUTBOX_MUTATIONS_TABLE), shard),
      );
    }
    if (baseVersionstamp) {
      query = query.where("entryVersionstamp", ">", baseVersionstamp);
    }
    query = query.limit(1);
    const result = await runtime.driver.executeQuery(query.compile());
    return result.rows.length > 0;
  }

  const grouped = groupTables(unknownReads);
  let query = db.selectFrom(OUTBOX_MUTATIONS_TABLE).select(sql<number>`1`.as("exists"));
  if (shouldApplyShardFilter(runtime)) {
    const shard = resolveShard(runtime);
    query = query.where((eb) =>
      buildShardPredicate(eb, resolveShardColumn(runtime, OUTBOX_MUTATIONS_TABLE), shard),
    );
  }

  if (baseVersionstamp) {
    query = query.where("entryVersionstamp", ">", baseVersionstamp);
  }

  query = query.where((eb) =>
    eb.or(
      grouped.map((group) =>
        eb.and([eb("schema", "=", group.schema), eb("table", "=", group.table)]),
      ),
    ),
  );

  query = query.limit(1);

  const result = await runtime.driver.executeQuery(query.compile());
  return result.rows.length > 0;
};

const hasScopeConflicts = async (
  runtime: ConflictCheckRuntime,
  baseVersionstamp: string | undefined,
  scope: ConflictReadScope,
): Promise<boolean> => {
  const db = createColdKysely(runtime.driverConfig.databaseType);
  const compiler = createSQLQueryCompiler(
    db,
    runtime.driverConfig,
    runtime.sqliteStorageMode,
    runtime.resolver,
  );

  const { query: baseQuery, aliases } = compiler.buildJoinQuery(scope.table, {
    where: scope.condition,
    join: scope.joins,
  });

  let query = baseQuery.select(sql<number>`1`.as("exists"));
  if (shouldApplyShardFilter(runtime)) {
    const shard = resolveShard(runtime);
    if (aliases.length > 0) {
      query = query.where((eb) =>
        eb.and(
          aliases.map((alias) =>
            buildShardPredicate(
              eb,
              `${alias.alias}.${resolveShardColumn(runtime, alias.table.name)}`,
              shard,
            ),
          ),
        ),
      );
    }
  }
  const mutationAliases: string[] = [];

  for (const [index, alias] of aliases.entries()) {
    const mutationAlias = `m_${index}`;
    mutationAliases.push(mutationAlias);

    const idColumn = alias.table.getIdColumn();
    const columnName = runtime.resolver
      ? runtime.resolver.getColumnName(alias.table.name, idColumn.name)
      : idColumn.name;

    query = query.leftJoin(`${OUTBOX_MUTATIONS_TABLE} as ${mutationAlias}`, (join) => {
      let on = join
        .on(`${mutationAlias}.schema`, "=", scope.schema)
        .on(`${mutationAlias}.table`, "=", alias.table.name)
        .onRef(`${mutationAlias}.externalId`, "=", `${alias.alias}.${columnName}`);

      if (baseVersionstamp) {
        on = on.on(`${mutationAlias}.entryVersionstamp`, ">", baseVersionstamp);
      }

      return on;
    });
  }

  if (mutationAliases.length > 0) {
    query = query.where((eb) =>
      eb.or(
        mutationAliases.map((alias) => {
          const entryCondition = eb(`${alias}.entryVersionstamp`, "is not", null);
          if (!shouldApplyShardFilter(runtime)) {
            return entryCondition;
          }
          const shard = resolveShard(runtime);
          const shardCondition = buildShardPredicate(
            eb,
            `${alias}.${resolveShardColumn(runtime, OUTBOX_MUTATIONS_TABLE)}`,
            shard,
          );
          return eb.and([entryCondition, shardCondition]);
        }),
      ),
    );
  }

  query = query.limit(1);

  const result = await runtime.driver.executeQuery(query.compile());
  return result.rows.length > 0;
};

export const checkConflicts = async (
  input: ConflictCheckInput,
  runtime: ConflictCheckRuntime,
): Promise<boolean> => {
  const unknownReadStrategy = input.unknownReadStrategy ?? "conflict";

  if (await hasKeyConflicts(runtime, input.baseVersionstamp, input.readKeys, input.writeKeys)) {
    return true;
  }

  for (const scope of input.readScopes) {
    if (await hasScopeConflicts(runtime, input.baseVersionstamp, scope)) {
      return true;
    }
  }

  if (
    await hasUnknownReadConflicts(
      runtime,
      input.baseVersionstamp,
      input.unknownReads ?? [],
      unknownReadStrategy,
    )
  ) {
    return true;
  }

  return false;
};
