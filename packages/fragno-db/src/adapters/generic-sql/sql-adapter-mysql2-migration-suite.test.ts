import { describe } from "vitest";

import { randomUUID } from "node:crypto";

import { MysqlDialect } from "kysely";
import { createPool, type PoolOptions } from "mysql2";
import { createPool as createPromisePool } from "mysql2/promise";

import type { NamingResolver } from "../../naming/sql-naming";
import type { SqlDriverAdapter } from "../../sql-driver/sql-driver-adapter";
import { describeMigrationSuite } from "../test-suite/migration-suite";
import type {
  ObservedColumn,
  ObservedForeignKey,
  ObservedIndex,
} from "../test-suite/migration-suite-harness";
import {
  BaseSqlMigrationInspector,
  normalizeDefault,
  normalizeType,
  query,
  quoteBare,
} from "../test-suite/sql-migration-inspector";
import { MySQL2DriverConfig } from "./driver-config";
import { SqlAdapter } from "./generic-sql-adapter";

const mysqlTestDatabase = process.env["FRAGNO_DB_MYSQL_TEST_DATABASE"];

class MySQLMigrationInspector extends BaseSqlMigrationInspector {
  protected async tableExists(driver: SqlDriverAdapter, tableName: string): Promise<boolean> {
    const result = await query(
      driver,
      `select table_name from information_schema.tables where table_schema = database() and table_name = ?`,
      [tableName],
    );
    return result.length > 0;
  }

  protected async inspectColumns(
    driver: SqlDriverAdapter,
    tableName: string,
  ): Promise<Record<string, ObservedColumn>> {
    const rows = await query(
      driver,
      `select column_name, is_nullable, data_type, column_default from information_schema.columns where table_name = ? and table_schema = database()`,
      [tableName],
    );

    return Object.fromEntries(
      rows.map((row) => [
        String(row["column_name"]),
        {
          exists: true,
          nullable: String(row["is_nullable"]).toUpperCase() === "YES",
          logicalType: normalizeType(String(row["data_type"] ?? "")),
          defaultKind: normalizeDefault(row["column_default"]),
        } satisfies ObservedColumn,
      ]),
    );
  }

  protected async inspectIndex(
    driver: SqlDriverAdapter,
    tableName: string,
    indexName: string,
  ): Promise<ObservedIndex | undefined> {
    const rows = await query(
      driver,
      `select index_name, non_unique, column_name from information_schema.statistics where table_schema = database() and table_name = ? and index_name = ? order by seq_in_index`,
      [tableName, indexName],
    );
    if (rows.length === 0) {
      return undefined;
    }
    return {
      exists: true,
      unique: Number(rows[0]!["non_unique"]) === 0,
      columns: rows.map((row) => String(row["column_name"])),
    };
  }

  protected async inspectForeignKeys(
    driver: SqlDriverAdapter,
    tableName: string,
  ): Promise<ObservedForeignKey[]> {
    const rows = await query(
      driver,
      `select column_name, referenced_table_name, referenced_column_name from information_schema.key_column_usage where table_schema = database() and table_name = ? and referenced_table_name is not null`,
      [tableName],
    );
    return rows.map((row) => ({
      columns: [String(row["column_name"])],
      referencesTable: String(row["referenced_table_name"]),
      referencesColumns: [String(row["referenced_column_name"])],
    }));
  }

  protected async inspectSettings(
    driver: SqlDriverAdapter,
  ): Promise<Record<string, string | undefined>> {
    try {
      const rows = await query(driver, `select \`key\`, value from fragno_db_settings`);
      return Object.fromEntries(rows.map((row) => [String(row["key"]), String(row["value"])]));
    } catch {
      return {};
    }
  }

  protected legacyCurrentStatements(resolver: NamingResolver): string[] {
    const usersTable = this.quote(resolver.getTableName("users"));
    const postsTable = this.quote(resolver.getTableName("posts"));
    const emailIndex = this.quote(resolver.getUniqueIndexName("users_email_idx", "users"));
    const ageIndex = this.quote(resolver.getIndexName("users_age_idx", "users"));
    const postsAuthorIndex = this.quote(resolver.getIndexName("posts_author_idx", "posts"));

    return [
      `create table ${usersTable} (\`id\` varchar(128) not null unique, \`email\` varchar(191) not null, \`name\` varchar(191), \`age\` integer, \`_internalId\` bigint not null auto_increment, \`_version\` integer default 0 not null, primary key (\`_internalId\`))`,
      `create unique index ${emailIndex} on ${usersTable} (\`email\`)`,
      `create index ${ageIndex} on ${usersTable} (\`age\`)`,
      `create table ${postsTable} (\`id\` varchar(128) not null unique, \`authorId\` bigint not null, \`title\` varchar(191) not null, \`createdAt\` datetime default current_timestamp not null, \`_internalId\` bigint not null auto_increment, \`_version\` integer default 0 not null, primary key (\`_internalId\`))`,
      `create index ${postsAuthorIndex} on ${postsTable} (\`authorId\`)`,
    ];
  }

  private quote(identifier: string): string {
    return quoteBare(identifier, "`");
  }
}

if (!mysqlTestDatabase) {
  describe.skip("migration contract: generic-sql mysql2", () => {
    // Set FRAGNO_DB_MYSQL_TEST_DATABASE to a MySQL connection URL to run this suite.
  });
} else {
  const baseOptions = createPoolOptions(mysqlTestDatabase);
  const baseDatabase = baseOptions.database ?? "fragno_test";

  describeMigrationSuite({
    name: "generic-sql mysql2",
    createAdapter: async () => createMysqlAdapterContext(baseOptions, baseDatabase),
    inspector: new MySQLMigrationInspector(),
    capabilities: {
      foreignKeys: false,
    },
  });
}

async function createMysqlAdapterContext(
  baseOptions: PoolOptions,
  baseDatabase: string,
): Promise<{ adapter: SqlAdapter; close: () => Promise<void> }> {
  const database = createTestDatabaseName(baseDatabase);
  const adminPool = createPromisePool({ ...baseOptions, database: undefined });
  try {
    await adminPool.query(`CREATE DATABASE \`${escapeIdentifier(database)}\``);
  } finally {
    await adminPool.end();
  }

  const adapter = new SqlAdapter({
    dialect: new MysqlDialect({ pool: createPool({ ...baseOptions, database }) }),
    driverConfig: new MySQL2DriverConfig(),
  });

  return {
    adapter,
    close: async () => {
      await adapter.close();
      const cleanupPool = createPromisePool({ ...baseOptions, database: undefined });
      try {
        await cleanupPool.query(`DROP DATABASE IF EXISTS \`${escapeIdentifier(database)}\``);
      } finally {
        await cleanupPool.end();
      }
    },
  };
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
  return `${baseDatabase.slice(0, 48)}_migration_${suffix}`;
}

function escapeIdentifier(identifier: string): string {
  return identifier.replaceAll("`", "``");
}
