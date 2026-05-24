import { describe, expect, it } from "vitest";

import SQLite from "better-sqlite3";
import { SqliteDialect } from "kysely";

import { createNamingResolver, suffixNamingStrategy } from "../../naming/sql-naming";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import { SqlDriverAdapter } from "../../sql-driver/sql-driver-adapter";
import { BetterSQLite3DriverConfig } from "./driver-config";
import { SqlAdapter } from "./generic-sql-adapter";

describe("SQLite recreate-table foreign keys", () => {
  it("keeps foreign keys pointing at the original table after recreation", async () => {
    const database = new SQLite(":memory:");
    const dialect = new SqliteDialect({ database });
    const driver = new SqlDriverAdapter(dialect);
    const adapter = new SqlAdapter({
      dialect,
      driverConfig: new BetterSQLite3DriverConfig(),
    });

    const fkSchema = schema("fk_test", (s) => {
      return s
        .addTable("users", (t) => {
          return t.addColumn("id", idColumn()).addColumn("name", column("string"));
        })
        .addTable("sessions", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("userId", referenceColumn({ table: "users" }));
        })
        .alterTable("users", (t) => {
          return t.alterColumn("name").nullable();
        });
    });

    const namespace = "fk_test";
    const resolver = createNamingResolver(fkSchema, namespace, suffixNamingStrategy);
    const usersTable = resolver.getTableName("users");
    const sessionsTable = resolver.getTableName("sessions");

    const migrations = adapter.prepareMigrations(fkSchema, namespace);
    const beforeRecreateVersion = fkSchema.version - 1;

    try {
      await migrations.executeWithDriver(driver, 0, beforeRecreateVersion, {
        updateVersionInMigration: false,
      });
      await migrations.executeWithDriver(driver, beforeRecreateVersion, fkSchema.version, {
        updateVersionInMigration: false,
      });

      const fkRows = database
        .prepare(`PRAGMA foreign_key_list("${sessionsTable}")`)
        .all() as Array<{ table: string }>;

      expect(fkRows.length).toBeGreaterThan(0);
      for (const row of fkRows) {
        expect(row.table).toBe(usersTable);
        expect(row.table).not.toContain("__fragno_tmp_");
      }
    } finally {
      await driver.destroy();
    }
  });
});

describe("SQLite migration failure scenarios", () => {
  const createAdapter = () => {
    const database = new SQLite(":memory:");
    const dialect = new SqliteDialect({ database });
    const driver = new SqlDriverAdapter(dialect);
    const adapter = new SqlAdapter({
      dialect,
      driverConfig: new BetterSQLite3DriverConfig(),
    });

    return { adapter, driver, database };
  };

  it("fails when adding a foreign key after tables already exist", async () => {
    const { adapter, driver } = createAdapter();
    const fkLaterSchema = schema("fk_later_runtime", (s) => {
      return s
        .addTable("users", (t) => {
          return t.addColumn("id", idColumn()).addColumn("name", column("string"));
        })
        .addTable("posts", (t) => {
          return t.addColumn("id", idColumn()).addColumn("title", column("string"));
        })
        .alterTable("posts", (t) => {
          return t.addColumn("authorId", referenceColumn({ table: "users" }));
        });
    });

    const namespace = "fk_later_runtime";
    const migrations = adapter.prepareMigrations(fkLaterSchema, namespace);
    const beforeFkVersion = fkLaterSchema.version - 1;

    try {
      await migrations.executeWithDriver(driver, 0, beforeFkVersion, {
        updateVersionInMigration: false,
      });

      await expect(
        migrations.executeWithDriver(driver, beforeFkVersion, fkLaterSchema.version, {
          updateVersionInMigration: false,
        }),
      ).rejects.toThrow(/foreign keys/i);
    } finally {
      await driver.destroy();
    }
  });

  it("fails when adding a NOT NULL column without default to a table with data", async () => {
    const { adapter, driver, database } = createAdapter();
    const addNotNullSchema = schema("add_not_null", (s) => {
      return s
        .addTable("items", (t) => {
          return t.addColumn("id", idColumn()).addColumn("name", column("string"));
        })
        .alterTable("items", (t) => {
          return t.addColumn("status", column("string"));
        });
    });

    const namespace = "add_not_null";
    const resolver = createNamingResolver(addNotNullSchema, namespace, suffixNamingStrategy);
    const itemsTable = resolver.getTableName("items");
    const migrations = adapter.prepareMigrations(addNotNullSchema, namespace);
    const beforeAddVersion = addNotNullSchema.version - 1;

    try {
      await migrations.executeWithDriver(driver, 0, beforeAddVersion, {
        updateVersionInMigration: false,
      });

      database
        .prepare(`insert into "${itemsTable}" ("id", "name") values (?, ?)`)
        .run("item-1", "First");

      await expect(
        migrations.executeWithDriver(driver, beforeAddVersion, addNotNullSchema.version, {
          updateVersionInMigration: false,
        }),
      ).rejects.toThrow(/not null/i);
    } finally {
      await driver.destroy();
    }
  });

  it("fails when tightening a nullable column with existing NULL values", async () => {
    const { adapter, driver, database } = createAdapter();
    const tightenSchema = schema("tighten_nullable", (s) => {
      return s
        .addTable("items", (t) => {
          return t.addColumn("id", idColumn()).addColumn("note", column("string").nullable());
        })
        .alterTable("items", (t) => {
          return t.alterColumn("note").nullable(false);
        });
    });

    const namespace = "tighten_nullable";
    const resolver = createNamingResolver(tightenSchema, namespace, suffixNamingStrategy);
    const itemsTable = resolver.getTableName("items");
    const migrations = adapter.prepareMigrations(tightenSchema, namespace);
    const beforeTightenVersion = tightenSchema.version - 1;

    try {
      await migrations.executeWithDriver(driver, 0, beforeTightenVersion, {
        updateVersionInMigration: false,
      });

      database
        .prepare(`insert into "${itemsTable}" ("id", "note") values (?, ?)`)
        .run("item-1", null);

      await expect(
        migrations.executeWithDriver(driver, beforeTightenVersion, tightenSchema.version, {
          updateVersionInMigration: false,
        }),
      ).rejects.toThrow(/not null/i);
    } finally {
      await driver.destroy();
    }
  });

  it("fails when adding a unique index with duplicate data", async () => {
    const { adapter, driver, database } = createAdapter();
    const uniqueIndexSchema = schema("unique_index", (s) => {
      return s
        .addTable("items", (t) => {
          return t.addColumn("id", idColumn()).addColumn("name", column("string"));
        })
        .alterTable("items", (t) => {
          return t.createIndex("unique_name", ["name"], { unique: true });
        });
    });

    const namespace = "unique_index";
    const resolver = createNamingResolver(uniqueIndexSchema, namespace, suffixNamingStrategy);
    const itemsTable = resolver.getTableName("items");
    const migrations = adapter.prepareMigrations(uniqueIndexSchema, namespace);
    const beforeIndexVersion = uniqueIndexSchema.version - 1;

    try {
      await migrations.executeWithDriver(driver, 0, beforeIndexVersion, {
        updateVersionInMigration: false,
      });

      const insert = database.prepare(`insert into "${itemsTable}" ("id", "name") values (?, ?)`);
      insert.run("item-1", "dup");
      insert.run("item-2", "dup");

      await expect(
        migrations.executeWithDriver(driver, beforeIndexVersion, uniqueIndexSchema.version, {
          updateVersionInMigration: false,
        }),
      ).rejects.toThrow(/unique/i);
    } finally {
      await driver.destroy();
    }
  });
});
