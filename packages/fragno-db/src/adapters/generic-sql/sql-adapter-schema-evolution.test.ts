import { describe, expect, it, assert } from "vitest";

import SQLite from "better-sqlite3";
import { SqliteDialect, sql, type RawBuilder } from "kysely";
import { KyselyPGlite } from "kysely-pglite";

import { PGlite } from "@electric-sql/pglite";

import { DatabaseConstraintError } from "../../errors";
import { createNamingResolver } from "../../naming/sql-naming";
import { column, idColumn, schema } from "../../schema/create";
import { BetterSQLite3DriverConfig, PGLiteDriverConfig } from "./driver-config";
import { SqlAdapter } from "./generic-sql-adapter";
import { createColdKysely } from "./migration/cold-kysely";

// Each step is one deploy of the fragment: the first creates the table, the later ones evolve it
// while it holds rows.
const evolvingSchema = schema("evolving", (s) =>
  s
    .addTable("installation", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("organizationId", column("string"))
        .addColumn("note", column("string"))
        .createIndex("idx_installation_org", ["organizationId", "id"])
        .createIndex("uniq_installation_note", ["note"], { unique: true }),
    )
    .alterTable("installation", (t) =>
      t
        .renameColumn("organizationId", "ownerId")
        .dropIndex("idx_installation_org")
        .createIndex("idx_installation_owner", ["ownerId", "id"])
        // Same name, other columns: a note is now unique per owner.
        .dropIndex("uniq_installation_note")
        .createIndex("uniq_installation_note", ["ownerId", "note"], { unique: true }),
    )
    // Changing nullability makes SQLite rebuild the table, which must keep the renamed column's
    // data and the current indexes only, not one dropped in the same step.
    .alterTable("installation", (t) =>
      t
        .renameColumn("note", "label")
        .alterColumn("label")
        .nullable()
        .dropIndex("idx_installation_owner")
        .createIndex("idx_installation_owner", ["ownerId", "label"]),
    ),
);

const databases = [
  {
    name: "SQLite",
    database: "sqlite",
    createAdapter: () => {
      const dialect = new SqliteDialect({ database: new SQLite(":memory:") });
      return new SqlAdapter({ dialect, driverConfig: new BetterSQLite3DriverConfig() });
    },
    listIndexes: (table: string) =>
      sql`select name from sqlite_master where type = 'index' and tbl_name = ${table}`,
    rejectsDuplicates: (promise: Promise<unknown>) =>
      expect(promise).rejects.toBeInstanceOf(DatabaseConstraintError),
  },
  {
    name: "PGlite",
    database: "postgresql",
    createAdapter: () => {
      const { dialect } = new KyselyPGlite(new PGlite());
      return new SqlAdapter({ dialect, driverConfig: new PGLiteDriverConfig() });
    },
    listIndexes: (table: string) =>
      sql`select indexname as name from pg_indexes where tablename = ${table}`,
    // PGlite does not classify constraint errors.
    rejectsDuplicates: (promise: Promise<unknown>) => expect(promise).rejects.toThrow(),
  },
] as const;

describe.each(databases)("evolving a table with rows on $name", (database) => {
  // A namespace may put the fragment's tables in their own database schema.
  it.each([null, "evolving"])(
    "renames columns and replaces indexes without losing rows (namespace %s)",
    async (namespace) => {
      const adapter = database.createAdapter();
      const migrations = adapter.prepareMigrations(evolvingSchema, namespace);
      const resolver = createNamingResolver(evolvingSchema, namespace, adapter.namingStrategy);
      const table = resolver.getTableName("installation");
      const schemaName = resolver.getSchemaName();
      const qualifiedTable = sql.table(schemaName ? `${schemaName}.${table}` : table);
      const kysely = createColdKysely(database.database);
      const run = async (query: RawBuilder<unknown>) =>
        (await adapter.driver.executeQuery(query.compile(kysely))).rows;
      const indexNames = async () =>
        (await run(database.listIndexes(table))).map(({ name }) => String(name));

      try {
        await migrations.executeWithDriver(adapter.driver, 0, 1, {
          updateVersionInMigration: false,
        });
        const indexesBefore = await indexNames();
        await run(
          sql`insert into ${qualifiedTable} (${sql.ref("id")}, ${sql.ref("organizationId")}, ${sql.ref("note")})
            values ('first', 'org-1', 'shared'), ('second', 'org-1', 'own')`,
        );

        for (const [from, to] of [
          [1, 2],
          [2, 3],
        ]) {
          await migrations.executeWithDriver(adapter.driver, from, to, {
            updateVersionInMigration: false,
          });
        }

        expect(
          await run(
            sql`select ${sql.ref("id")}, ${sql.ref("ownerId")}, ${sql.ref("label")} from ${qualifiedTable} order by ${sql.ref("id")}`,
          ),
        ).toEqual([
          { id: "first", ownerId: "org-1", label: "shared" },
          { id: "second", ownerId: "org-1", label: "own" },
        ]);
        const ownerIndex = resolver.getIndexName("idx_installation_owner", "installation");
        const droppedIndex = resolver.getIndexName("idx_installation_org", "installation");
        const uniqueIndex = resolver.getUniqueIndexName("uniq_installation_note", "installation");
        expect(indexesBefore).toEqual(expect.arrayContaining([droppedIndex, uniqueIndex]));
        const indexesAfter = await indexNames();
        expect(indexesAfter).toEqual(expect.arrayContaining([ownerIndex, uniqueIndex]));
        expect(indexesAfter).not.toContain(droppedIndex);

        // The fragment reads and writes through the renamed column and the new indexes.
        const [owned] = await adapter
          .createUnitOfWork(evolvingSchema, namespace, "read-owned")
          .find("installation", (b) =>
            b.whereIndex("idx_installation_owner", (eb) => eb("ownerId", "=", "org-1")),
          )
          .executeRetrieve();
        expect(new Set(owned.map(({ label }) => label))).toEqual(new Set(["own", "shared"]));

        const otherOwner = adapter.createUnitOfWork(evolvingSchema, namespace, "other-owner");
        otherOwner.create("installation", { id: "third", ownerId: "org-2", label: "shared" });
        assert((await otherOwner.executeMutations()).success);
        const duplicate = adapter.createUnitOfWork(evolvingSchema, namespace, "duplicate");
        duplicate.create("installation", { id: "fourth", ownerId: "org-1", label: "shared" });
        await database.rejectsDuplicates(duplicate.executeMutations());
      } finally {
        await adapter.close();
      }
    },
  );
});
