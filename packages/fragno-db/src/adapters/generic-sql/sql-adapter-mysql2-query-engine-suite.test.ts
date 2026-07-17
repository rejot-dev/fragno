import { afterAll, describe, test, assert } from "vitest";

import { randomUUID } from "node:crypto";

import { MysqlDialect } from "kysely";
import { createPool, type PoolOptions } from "mysql2";
import { createPool as createPromisePool } from "mysql2/promise";

import { describeQueryEngineSuite } from "../test-suite/query-engine-suite";
import { MySQL2DriverConfig } from "./driver-config";
import { SqlAdapter } from "./generic-sql-adapter";

class MySQLTestDatabaseRegistry {
  readonly #adminPoolOptions: PoolOptions;
  readonly #runId = randomUUID().replaceAll("-", "").slice(0, 10);
  readonly #activeDatabases = new Set<string>();
  #databaseSequence = 0;

  constructor(adminPoolOptions: PoolOptions) {
    this.#adminPoolOptions = { ...adminPoolOptions, database: undefined };
  }

  async create(baseDatabase: string, variant: MySQLVariant): Promise<string> {
    const database = createTestDatabaseName(baseDatabase, this.#runId, this.#databaseSequence++);
    const adminPool = createPromisePool(this.#adminPoolOptions);
    try {
      await adminPool.query(createDatabaseSql(database, variant));
      this.#activeDatabases.add(database);
      return database;
    } finally {
      await adminPool.end();
    }
  }

  async drop(database: string): Promise<void> {
    if (!this.#activeDatabases.has(database)) {
      return;
    }

    const adminPool = createPromisePool(this.#adminPoolOptions);
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS \`${escapeIdentifier(database)}\``);
      this.#activeDatabases.delete(database);
    } finally {
      await adminPool.end();
    }
  }

  async cleanup(): Promise<void> {
    const cleanupErrors: unknown[] = [];
    for (const database of this.#activeDatabases) {
      try {
        await this.drop(database);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Failed to clean up MySQL test databases.");
    }
  }
}

const mysqlTestDatabase = process.env["FRAGNO_DB_MYSQL_TEST_DATABASE"];
const mysqlVariantsEnabled = process.env["FRAGNO_DB_MYSQL_ENABLE_VARIANT"] === "true";

if (!mysqlTestDatabase) {
  describe.skip("query engine contract: generic-sql mysql2", () => {
    // Set FRAGNO_DB_MYSQL_TEST_DATABASE to a MySQL connection URL to run this suite.
  });
} else {
  const baseOptions = createPoolOptions(mysqlTestDatabase);
  const baseDatabase = baseOptions.database ?? "fragno_test";
  const databaseRegistry = new MySQLTestDatabaseRegistry(baseOptions);

  afterAll(async () => {
    await databaseRegistry.cleanup();
  });

  describeMysqlQueryEngineSuite(
    baseOptions,
    baseDatabase,
    getDefaultMysqlVariant(),
    databaseRegistry,
  );

  if (!mysqlVariantsEnabled) {
    describe.skip("query engine contract: generic-sql mysql2 variants", () => {
      // Set FRAGNO_DB_MYSQL_ENABLE_VARIANT=true to run charset/timezone variants.
    });
  } else {
    for (const variant of getMysqlConfigVariants()) {
      describeMysqlQueryEngineSuite(baseOptions, baseDatabase, variant, databaseRegistry);
    }

    describe("generic-sql mysql2 configuration variants", () => {
      test.each(getMysqlConfigVariants())("creates databases using $name", async (variant) => {
        const { adapter, close } = await createMysqlAdapterContext(
          baseOptions,
          baseDatabase,
          variant,
          databaseRegistry,
        );
        try {
          assert(await adapter.isConnectionHealthy());
        } finally {
          await close();
        }
      });
    });
  }
}

type MySQLVariant = {
  name: string;
  databaseCharset?: string;
  databaseCollation?: string;
  poolOptions?: Pick<PoolOptions, "charset" | "timezone">;
};

function getDefaultMysqlVariant(): MySQLVariant {
  return { name: "default" };
}

function getMysqlConfigVariants(): MySQLVariant[] {
  return [
    {
      name: "utc utf8mb4_unicode_ci",
      databaseCharset: "utf8mb4",
      databaseCollation: "utf8mb4_unicode_ci",
      poolOptions: { charset: "utf8mb4_unicode_ci", timezone: "Z" },
    },
    {
      name: "offset utf8mb4_bin",
      databaseCharset: "utf8mb4",
      databaseCollation: "utf8mb4_bin",
      poolOptions: { charset: "utf8mb4_bin", timezone: "+00:00" },
    },
  ];
}

function describeMysqlQueryEngineSuite(
  baseOptions: PoolOptions,
  baseDatabase: string,
  variant: MySQLVariant,
  databaseRegistry: MySQLTestDatabaseRegistry,
): void {
  describeQueryEngineSuite({
    name: `generic-sql mysql2 ${variant.name}`,
    capabilities: {
      constraints: false,
    },
    createAdapter: async () =>
      createMysqlAdapterContext(baseOptions, baseDatabase, variant, databaseRegistry),
  });
}

async function createMysqlAdapterContext(
  baseOptions: PoolOptions,
  baseDatabase: string,
  variant: MySQLVariant,
  databaseRegistry: MySQLTestDatabaseRegistry,
): Promise<{ adapter: SqlAdapter; close: () => Promise<void> }> {
  const database = await databaseRegistry.create(baseDatabase, variant);
  const poolOptions = { ...baseOptions, ...variant.poolOptions, database };
  const adapter = new SqlAdapter({
    dialect: new MysqlDialect({ pool: createPool(poolOptions) }),
    driverConfig: new MySQL2DriverConfig(),
  });

  return {
    adapter,
    close: async () => {
      try {
        await adapter.close();
      } finally {
        await databaseRegistry.drop(database);
      }
    },
  };
}

function createDatabaseSql(database: string, variant: MySQLVariant): string {
  const characterSet = variant.databaseCharset
    ? ` CHARACTER SET ${escapeIdentifier(variant.databaseCharset)}`
    : "";
  const collate = variant.databaseCollation
    ? ` COLLATE ${escapeIdentifier(variant.databaseCollation)}`
    : "";
  return `CREATE DATABASE \`${escapeIdentifier(database)}\`${characterSet}${collate}`;
}

function createPoolOptions(connectionUrl: string): PoolOptions {
  const url = new URL(connectionUrl);
  const database = url.pathname.replace(/^\//, "") || undefined;

  return {
    host: url.hostname || "127.0.0.1",
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: database ? decodeURIComponent(database) : undefined,
  };
}

function createTestDatabaseName(baseDatabase: string, runId: string, sequence: number): string {
  const suffix = `_qe_${runId}_${sequence.toString(36)}`;
  return `${baseDatabase.slice(0, 64 - suffix.length)}${suffix}`;
}

function escapeIdentifier(identifier: string): string {
  return identifier.replaceAll("`", "``");
}
