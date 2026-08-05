import SQLite from "better-sqlite3";
import { SqliteDialect } from "kysely";

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
import { BetterSQLite3DriverConfig } from "./driver-config";
import { SqlAdapter } from "./generic-sql-adapter";

class SQLiteMigrationInspector extends BaseSqlMigrationInspector {
  protected async tableExists(driver: SqlDriverAdapter, tableName: string): Promise<boolean> {
    const result = await query(
      driver,
      `select name from sqlite_master where type = 'table' and name = ?`,
      [tableName],
    );
    return result.length > 0;
  }

  protected async inspectColumns(
    driver: SqlDriverAdapter,
    tableName: string,
  ): Promise<Record<string, ObservedColumn>> {
    const rows = await query(driver, `pragma table_info(${this.quote(tableName)})`);
    return Object.fromEntries(
      rows.map((row) => [
        String(row["name"]),
        {
          exists: true,
          nullable: Number(row["notnull"]) === 0 && Number(row["pk"]) === 0,
          logicalType: normalizeType(String(row["type"] ?? "")),
          defaultKind: normalizeDefault(row["dflt_value"]),
        } satisfies ObservedColumn,
      ]),
    );
  }

  protected async inspectIndex(
    driver: SqlDriverAdapter,
    tableName: string,
    indexName: string,
  ): Promise<ObservedIndex | undefined> {
    const rows = await query(driver, `pragma index_list(${this.quote(tableName)})`);
    const index = rows.find((row) => row["name"] === indexName);
    if (!index) {
      return undefined;
    }
    const columns = await query(driver, `pragma index_info(${this.quote(indexName)})`);
    return {
      exists: true,
      unique: Number(index["unique"]) === 1,
      columns: columns.map((row) => String(row["name"])),
    };
  }

  protected async inspectForeignKeys(
    driver: SqlDriverAdapter,
    tableName: string,
  ): Promise<ObservedForeignKey[]> {
    const rows = await query(driver, `pragma foreign_key_list(${this.quote(tableName)})`);
    return rows.map((row) => ({
      columns: [String(row["from"])],
      referencesTable: String(row["table"]),
      referencesColumns: [String(row["to"])],
    }));
  }

  protected async inspectSettings(
    driver: SqlDriverAdapter,
  ): Promise<Record<string, string | undefined>> {
    try {
      const rows = await query(driver, `select "key", value from fragno_db_settings`);
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
      `create table ${usersTable} ("id" text not null unique, "email" text not null, "name" text, "age" integer, "_internalId" integer not null primary key autoincrement, "_version" integer default 0 not null)`,
      `create unique index ${emailIndex} on ${usersTable} ("email")`,
      `create index ${ageIndex} on ${usersTable} ("age")`,
      `create table ${postsTable} ("id" text not null unique, "authorId" integer not null, "title" text not null, "createdAt" integer not null, "_internalId" integer not null primary key autoincrement, "_version" integer default 0 not null)`,
      `create index ${postsAuthorIndex} on ${postsTable} ("authorId")`,
    ];
  }

  private quote(identifier: string): string {
    return quoteBare(identifier, '"');
  }
}

describeMigrationSuite({
  name: "generic-sql sqlite3",
  createAdapter: async () => {
    const database = new SQLite(":memory:");
    const adapter = new SqlAdapter({
      dialect: new SqliteDialect({ database }),
      driverConfig: new BetterSQLite3DriverConfig(),
    });
    return { adapter, close: () => adapter.close() };
  },
  inspector: new SQLiteMigrationInspector(),
  capabilities: {
    foreignKeys: false,
  },
});
