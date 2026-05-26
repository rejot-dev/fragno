import { describe, expect, test } from "vitest";

import { randomUUID } from "node:crypto";

import { MysqlDialect } from "kysely";
import { createPool, type PoolOptions } from "mysql2";
import { createPool as createPromisePool } from "mysql2/promise";

import { describeQueryEngineSuite } from "../test-suite/query-engine-suite";
import { MySQL2DriverConfig } from "./driver-config";
import { SqlAdapter } from "./generic-sql-adapter";

const mysqlTestDatabase = process.env["FRAGNO_DB_MYSQL_TEST_DATABASE"];
const mysqlVariantsEnabled = process.env["FRAGNO_DB_MYSQL_ENABLE_VARIANT"] === "true";

if (!mysqlTestDatabase) {
  describe.skip("query engine contract: generic-sql mysql2", () => {
    // Set FRAGNO_DB_MYSQL_TEST_DATABASE to a MySQL connection URL to run this suite.
  });
} else {
  const baseOptions = createPoolOptions(mysqlTestDatabase);
  const baseDatabase = baseOptions.database ?? "fragno_test";

  describeMysqlQueryEngineSuite(baseOptions, baseDatabase, getDefaultMysqlVariant());

  if (!mysqlVariantsEnabled) {
    describe.skip("query engine contract: generic-sql mysql2 variants", () => {
      // Set FRAGNO_DB_MYSQL_ENABLE_VARIANT=true to run charset/timezone variants.
    });
  } else {
    for (const variant of getMysqlConfigVariants()) {
      describeMysqlQueryEngineSuite(baseOptions, baseDatabase, variant);
    }

    describe("generic-sql mysql2 configuration variants", () => {
      test.each(getMysqlConfigVariants())("creates databases using $name", async (variant) => {
        const { adapter, close } = await createMysqlAdapterContext(
          baseOptions,
          baseDatabase,
          variant,
        );
        try {
          expect(await adapter.isConnectionHealthy()).toBe(true);
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
): void {
  describeQueryEngineSuite({
    name: `generic-sql mysql2 ${variant.name}`,
    capabilities: {
      constraints: false,
    },
    createAdapter: async () => createMysqlAdapterContext(baseOptions, baseDatabase, variant),
  });
}

async function createMysqlAdapterContext(
  baseOptions: PoolOptions,
  baseDatabase: string,
  variant: MySQLVariant,
): Promise<{ adapter: SqlAdapter; close: () => Promise<void> }> {
  const database = createTestDatabaseName(baseDatabase);
  const adminPool = createPromisePool({ ...baseOptions, database: undefined });
  await adminPool.query(createDatabaseSql(database, variant));
  await adminPool.end();

  const poolOptions = { ...baseOptions, ...variant.poolOptions, database };
  const adapter = new SqlAdapter({
    dialect: new MysqlDialect({ pool: createPool(poolOptions) }),
    driverConfig: new MySQL2DriverConfig(),
  });

  return {
    adapter,
    close: async () => {
      await adapter.close();
      const cleanupPool = createPromisePool({ ...baseOptions, database: undefined });
      await cleanupPool.query(`DROP DATABASE IF EXISTS \`${escapeIdentifier(database)}\``);
      await cleanupPool.end();
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

function createTestDatabaseName(baseDatabase: string): string {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  return `${baseDatabase.slice(0, 48)}_qe_${suffix}`;
}

function escapeIdentifier(identifier: string): string {
  return identifier.replaceAll("`", "``");
}
