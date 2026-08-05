import { KyselyPGlite } from "kysely-pglite";

import { PGlite } from "@electric-sql/pglite";

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
import { PGLiteDriverConfig } from "./driver-config";
import { SqlAdapter } from "./generic-sql-adapter";

class PostgresMigrationInspector extends BaseSqlMigrationInspector {
  protected async tableExists(
    driver: SqlDriverAdapter,
    tableName: string,
    resolver: NamingResolver,
  ): Promise<boolean> {
    const result = await query(
      driver,
      `select table_name from information_schema.tables where table_schema = $1 and table_name = $2`,
      [this.schemaName(resolver), tableName],
    );
    return result.length > 0;
  }

  protected async inspectColumns(
    driver: SqlDriverAdapter,
    tableName: string,
    resolver: NamingResolver,
  ): Promise<Record<string, ObservedColumn>> {
    const rows = await query(
      driver,
      `select column_name, is_nullable, data_type, column_default from information_schema.columns where table_name = $1 and table_schema = $2`,
      [tableName, this.schemaName(resolver)],
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
    resolver: NamingResolver,
  ): Promise<ObservedIndex | undefined> {
    const rows = await query(
      driver,
      `select i.relname as index_name, ix.indisunique as unique, a.attname as column_name
       from pg_class t
       join pg_index ix on t.oid = ix.indrelid
       join pg_class i on i.oid = ix.indexrelid
       join pg_attribute a on a.attrelid = t.oid and a.attnum = any(ix.indkey)
       join pg_namespace n on n.oid = t.relnamespace
       where n.nspname = $1 and t.relname = $2 and i.relname = $3
       order by array_position(ix.indkey, a.attnum)`,
      [this.schemaName(resolver), tableName, indexName],
    );
    if (rows.length === 0) {
      return undefined;
    }
    return {
      exists: true,
      unique: rows[0]!["unique"] === true,
      columns: rows.map((row) => String(row["column_name"])),
    };
  }

  protected async inspectForeignKeys(
    driver: SqlDriverAdapter,
    tableName: string,
    resolver: NamingResolver,
  ): Promise<ObservedForeignKey[]> {
    const rows = await query(
      driver,
      `select kcu.column_name, ccu.table_name as foreign_table_name, ccu.column_name as foreign_column_name
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
       join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
       where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = $1 and tc.table_name = $2`,
      [this.schemaName(resolver), tableName],
    );
    return rows.map((row) => ({
      columns: [String(row["column_name"])],
      referencesTable: String(row["foreign_table_name"]),
      referencesColumns: [String(row["foreign_column_name"])],
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
    const usersTable = this.qualified(resolver.getTableName("users"), resolver);
    const postsTable = this.qualified(resolver.getTableName("posts"), resolver);
    const emailIndex = this.quote(resolver.getUniqueIndexName("users_email_idx", "users"));
    const ageIndex = this.quote(resolver.getIndexName("users_age_idx", "users"));
    const postsAuthorIndex = this.quote(resolver.getIndexName("posts_author_idx", "posts"));
    const statements: string[] = [];
    const schemaName = resolver.getSchemaName();

    if (schemaName) {
      statements.push(`create schema if not exists ${this.quote(schemaName)}`);
    }

    statements.push(
      `create table ${usersTable} ("id" varchar(128) not null unique, "email" varchar(191) not null, "name" varchar(191), "age" integer, "_internalId" bigserial not null primary key, "_version" integer default 0 not null)`,
      `create unique index ${emailIndex} on ${usersTable} ("email")`,
      `create index ${ageIndex} on ${usersTable} ("age")`,
      `create table ${postsTable} ("id" varchar(128) not null unique, "authorId" bigint not null, "title" varchar(191) not null, "createdAt" timestamp default current_timestamp not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null)`,
      `create index ${postsAuthorIndex} on ${postsTable} ("authorId")`,
    );
    return statements;
  }

  private qualified(identifier: string, resolver: NamingResolver): string {
    const schemaName = resolver.getSchemaName();
    return schemaName
      ? `${this.quote(schemaName)}.${this.quote(identifier)}`
      : this.quote(identifier);
  }

  private quote(identifier: string): string {
    return quoteBare(identifier, '"');
  }

  private schemaName(resolver: NamingResolver): string {
    return resolver.getSchemaName() ?? "public";
  }
}

describeMigrationSuite({
  name: "generic-sql pglite",
  createAdapter: async () => {
    const database = new PGlite();
    const { dialect } = new KyselyPGlite(database);
    const adapter = new SqlAdapter({ dialect, driverConfig: new PGLiteDriverConfig() });
    return { adapter, close: () => adapter.close() };
  },
  inspector: new PostgresMigrationInspector(),
  capabilities: {
    foreignKeys: false,
  },
});
