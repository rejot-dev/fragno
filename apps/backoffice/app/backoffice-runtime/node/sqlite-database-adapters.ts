import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { BetterSQLite3DriverConfig } from "@fragno-dev/db/drivers";
import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";

import type {
  BackofficeDatabaseAdapterFactory,
  BackofficeDatabaseAdapterKind,
  BackofficeDatabaseAdapterScope,
  CreateBackofficeDatabaseAdapterInput,
} from "../database-adapters";
import { configureBackofficeSqliteConnection } from "./sqlite-connection-config";

const sharedDatabaseKinds = new Set<BackofficeDatabaseAdapterKind>(["automations", "pi"]);

type SqliteBackofficeDatabaseAdapters = BackofficeDatabaseAdapterFactory & {
  cleanup(): Promise<void>;
};

type SqliteAdapterPool = {
  adapters: Map<string, SqlAdapter>;
};

/** File-backed Fragment databases, keyed by Durable Object identity and Fragment database name. */
export function createSqliteBackofficeDatabaseAdapters(
  directory: string,
  scope?: BackofficeDatabaseAdapterScope,
  pool: SqliteAdapterPool = { adapters: new Map() },
): SqliteBackofficeDatabaseAdapters {
  return {
    createAdapter(input: CreateBackofficeDatabaseAdapterInput) {
      const id = scope?.id ?? "singleton";
      const key = sharedDatabaseKinds.has(input.kind)
        ? `${id}:${input.kind}`
        : `${id}:${input.kind}:${input.databaseName?.trim() || "default"}`;
      const existing = pool.adapters.get(key);
      if (existing) {
        return existing;
      }
      mkdirSync(directory, { recursive: true });
      const hash = createHash("sha256").update(key).digest("hex");
      const database = new Database(path.join(directory, `${input.kind}-${hash}.sqlite`));
      configureBackofficeSqliteConnection(database);
      const adapter = new SqlAdapter({
        dialect: new SqliteDialect({ database }),
        driverConfig: new BetterSQLite3DriverConfig(),
      });
      pool.adapters.set(key, adapter);
      return adapter;
    },
    forScope(nextScope) {
      return createSqliteBackofficeDatabaseAdapters(directory, nextScope, pool);
    },
    async cleanup() {
      await Promise.all([...pool.adapters.values()].map((adapter) => adapter.close()));
      pool.adapters.clear();
    },
  };
}
