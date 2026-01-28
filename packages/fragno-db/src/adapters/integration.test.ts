/**
 * Integration tests for fragno-db adapters against real databases.
 *
 * These tests run against PostgreSQL, MySQL, and SQLite using real database connections.
 * They are controlled by environment variables:
 * - FRAGNO_TEST_DATABASE: "postgres" | "mysql" | "sqlite"
 * - FRAGNO_TEST_POSTGRES_URL: PostgreSQL connection string
 * - FRAGNO_TEST_MYSQL_URL: MySQL connection string
 *
 * These tests are skipped when FRAGNO_TEST_DATABASE is not set, allowing the
 * existing PGlite/SQLite tests to continue running for fast local development.
 */
import { PostgresDialect, MysqlDialect, SqliteDialect } from "kysely";
import { Pool } from "pg";
import { createPool } from "mysql2";
import SQLite from "better-sqlite3";
import { beforeAll, describe } from "vitest";
import { KyselyAdapter } from "./kysely/kysely-adapter";
import {
  NodePostgresDriverConfig,
  MySQL2DriverConfig,
  BetterSQLite3DriverConfig,
} from "./generic-sql/driver-config";
import { internalSchema } from "../fragments/internal-fragment";
import { runAdapterTestSuite, testSchema } from "./shared/adapter-test-suite";

const databaseType = process.env["FRAGNO_TEST_DATABASE"];

type AdapterSetup = {
  adapter: KyselyAdapter;
  cleanup: () => Promise<void>;
};

function createAdapter(): AdapterSetup | null {
  if (databaseType === "postgres") {
    const connectionString = process.env["FRAGNO_TEST_POSTGRES_URL"];
    if (!connectionString) {
      throw new Error("FRAGNO_TEST_POSTGRES_URL is required for postgres tests");
    }
    const pool = new Pool({ connectionString });
    const dialect = new PostgresDialect({ pool });
    const adapter = new KyselyAdapter({
      dialect,
      driverConfig: new NodePostgresDriverConfig(),
    });
    return {
      adapter,
      cleanup: async () => {
        // adapter.close() closes the underlying pool
        await adapter.close();
      },
    };
  }

  if (databaseType === "mysql") {
    const connectionString = process.env["FRAGNO_TEST_MYSQL_URL"];
    if (!connectionString) {
      throw new Error("FRAGNO_TEST_MYSQL_URL is required for mysql tests");
    }
    const pool = createPool(connectionString);
    const dialect = new MysqlDialect({ pool });
    const adapter = new KyselyAdapter({
      dialect,
      driverConfig: new MySQL2DriverConfig(),
    });
    return {
      adapter,
      cleanup: async () => {
        // adapter.close() closes the underlying pool
        await adapter.close();
      },
    };
  }

  if (databaseType === "sqlite") {
    const database = new SQLite(":memory:");
    const dialect = new SqliteDialect({ database });
    const adapter = new KyselyAdapter({
      dialect,
      driverConfig: new BetterSQLite3DriverConfig(),
    });
    return {
      adapter,
      cleanup: async () => {
        // adapter.close() closes the underlying database
        await adapter.close();
      },
    };
  }

  return null;
}

const shouldRun = databaseType && ["postgres", "mysql", "sqlite"].includes(databaseType);

describe.skipIf(!shouldRun)(`Integration Tests (${databaseType})`, () => {
  let adapter: KyselyAdapter;
  let cleanup: () => Promise<void>;

  // Generate a unique namespace for each test run to avoid conflicts
  const namespace = `integration_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    const setup = createAdapter();
    if (!setup) {
      throw new Error(`Invalid database type: ${databaseType}`);
    }
    adapter = setup.adapter;
    cleanup = setup.cleanup;

    // Run migrations for internal schema (settings table)
    {
      const migrations = adapter.prepareMigrations(internalSchema, "");
      await migrations.executeWithDriver(adapter.driver, 0);
    }

    // Run migrations for test schema
    {
      const migrations = adapter.prepareMigrations(testSchema, namespace);
      await migrations.executeWithDriver(adapter.driver, 0);
    }

    return cleanup;
  }, 30000);

  // Run the shared adapter test suite
  runAdapterTestSuite({
    getQueryEngine: () => adapter.createQueryEngine(testSchema, namespace),
  });
});
