import { beforeAll, describe, expect, it, assert } from "vitest";

import SQLite from "better-sqlite3";
import { SqliteDialect } from "kysely";

import { internalSchema } from "../../fragments/internal-fragment";
import { generateSchemaArtifacts } from "../../migration-engine/generation-engine";
import { FragnoDatabase } from "../../mod";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import { BetterSQLite3DriverConfig } from "../generic-sql/driver-config";
import { SqlAdapter } from "../generic-sql/generic-sql-adapter";
import { sqliteStorageDefault, sqliteStoragePrisma } from "../generic-sql/sqlite-storage";

describe("SqlAdapter SQLite (prisma profile)", () => {
  const testSchema = schema("test", (s) => {
    return s
      .addTable("users", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("age", column("integer").nullable())
          .createIndex("name_idx", ["name"])
          .createIndex("name_id_idx", ["name", "id"]);
      })
      .addTable("emails", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("user_id", referenceColumn({ table: "users" }))
          .addColumn("email", column("string"))
          .addColumn("is_primary", column("bool").defaultTo(false))
          .createIndex("unique_email", ["email"], { unique: true })
          .createIndex("user_emails", ["user_id"]);
      })
      .addTable("posts", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("user_id", referenceColumn({ table: "users" }))
          .addColumn("title", column("string"))
          .addColumn("content", column("text"))
          .createIndex("posts_user_idx", ["user_id"]);
      })
      .addTable("comments", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("post_id", referenceColumn({ table: "posts" }))
          .addColumn("user_id", referenceColumn({ table: "users" }))
          .addColumn("text", column("text"))
          .createIndex("comments_post_idx", ["post_id"])
          .createIndex("comments_user_idx", ["user_id"]);
      })
      .addTable("events", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn(
            "created_at",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .addColumn("happened_on", column("date"))
          .addColumn("payload", column("json").nullable())
          .addColumn("big_score", column("bigint"))
          .createIndex("events_name_idx", ["name"]);
      });
  });

  const schema2 = schema("schema2", (s) => {
    return s
      .addTable("products", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("price", column("integer"))
          .createIndex("name_idx", ["name"]);
      })
      .addTable("orders", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("product_id", referenceColumn({ table: "products" }))
          .addColumn("quantity", column("integer"))
          .createIndex("product_orders_idx", ["product_id"]);
      });
  });

  let adapter: SqlAdapter;
  let sqliteDatabase: InstanceType<typeof SQLite>;

  beforeAll(async () => {
    sqliteDatabase = new SQLite(":memory:");

    const dialect = new SqliteDialect({
      database: sqliteDatabase,
    });

    adapter = new SqlAdapter({
      dialect,
      driverConfig: new BetterSQLite3DriverConfig(),
      sqliteProfile: "prisma",
    });

    {
      const migrations = adapter.prepareMigrations(internalSchema, "");
      await migrations.executeWithDriver(adapter.driver, 0);
    }

    {
      const migrations = adapter.prepareMigrations(testSchema, "namespace");
      await migrations.executeWithDriver(adapter.driver, 0);
    }

    {
      const migrations = adapter.prepareMigrations(schema2, "namespace2");
      await migrations.executeWithDriver(adapter.driver, 0);
    }

    return async () => {
      await adapter.close();
      sqliteDatabase.close();
    };
  }, 12000);

  it("should use prisma sqlite storage mode", () => {
    expect(adapter.sqliteStorageMode).toBe(sqliteStoragePrisma);
  });

  it("should default schema output path to fragno.prisma", async () => {
    const fragnoDb = new FragnoDatabase({
      namespace: "namespace",
      schema: testSchema,
      adapter,
    });

    const [result] = await generateSchemaArtifacts([fragnoDb], { format: "prisma" });

    assert(result.path === "fragno.prisma");
  });

  it("should store prisma storage values using sqlite-friendly types", async () => {
    const happenedOn = new Date("2024-06-18T12:34:56.789Z");
    const bigScore = 12345n;

    const createUow = adapter.createUnitOfWork(
      testSchema,
      "namespace",
      "create-prisma-storage-event",
    );
    createUow.create("events", {
      name: "Prisma Storage Event",
      happened_on: happenedOn,
      payload: { level: "info", tags: ["sqlite", "prisma"] },
      big_score: bigScore,
    });
    await createUow.executeMutations();

    const tableName = adapter.namingStrategy.tableName("events", "namespace");
    const row = sqliteDatabase
      .prepare(`SELECT happened_on, big_score FROM ${tableName} WHERE name = ?`)
      .get("Prisma Storage Event") as { happened_on?: unknown; big_score?: unknown } | undefined;

    assert(typeof row?.happened_on === "string");
    expect(row?.happened_on).toBe(happenedOn.toISOString());
    expect(row?.big_score).not.toBeInstanceOf(Buffer);
    expect(["number", "bigint"]).toContain(typeof row?.big_score);
  });

  it("should honor explicit sqlite storage overrides", async () => {
    const fragnoDatabase = new SQLite(":memory:");
    const fragnoDialect = new SqliteDialect({ database: fragnoDatabase });
    const fragnoAdapter = new SqlAdapter({
      dialect: fragnoDialect,
      driverConfig: new BetterSQLite3DriverConfig(),
      sqliteStorageMode: sqliteStorageDefault,
    });

    try {
      const internalMigrations = fragnoAdapter.prepareMigrations(internalSchema, "");
      await internalMigrations.executeWithDriver(fragnoAdapter.driver, 0);

      const migrations = fragnoAdapter.prepareMigrations(testSchema, "namespace");
      await migrations.executeWithDriver(fragnoAdapter.driver, 0);

      expect(fragnoAdapter.sqliteStorageMode).toBe(sqliteStorageDefault);

      const happenedOn = new Date("2024-06-18T12:34:56.789Z");
      const bigScore = 1234567890123n;

      const createUow = fragnoAdapter.createUnitOfWork(
        testSchema,
        "namespace",
        "create-fragno-storage-event",
      );
      createUow.create("events", {
        name: "Fragno Storage Event",
        happened_on: happenedOn,
        payload: { level: "info", tags: ["sqlite", "fragno"] },
        big_score: bigScore,
      });
      await createUow.executeMutations();

      const tableName = fragnoAdapter.namingStrategy.tableName("events", "namespace");
      const row = fragnoDatabase
        .prepare(`SELECT happened_on, big_score FROM ${tableName} WHERE name = ?`)
        .get("Fragno Storage Event") as { happened_on?: number; big_score?: Buffer } | undefined;

      assert(typeof row?.happened_on === "number");
      expect(row?.happened_on).toBe(happenedOn.getTime());
      expect(row?.big_score).toBeInstanceOf(Buffer);
      expect(row?.big_score?.readBigInt64BE(0)).toBe(bigScore);
    } finally {
      await fragnoAdapter.close();
      fragnoDatabase.close();
    }
  });
  it("should store Date values as UTC ISO strings for sqlite prisma storage", async () => {
    const happenedOn = new Date("2024-06-18T12:34:56.789Z");

    const createUow = adapter.createUnitOfWork(testSchema, "namespace", "create-iso-event");
    createUow.create("events", {
      name: "ISO Stored Event",
      happened_on: happenedOn,
      payload: { level: "info", tags: ["sqlite", "iso"] },
      big_score: 7n,
    });
    await createUow.executeMutations();

    const tableName = adapter.namingStrategy.tableName("events", "namespace");
    const row = sqliteDatabase
      .prepare(`SELECT happened_on FROM ${tableName} WHERE name = ?`)
      .get("ISO Stored Event") as { happened_on?: string } | undefined;

    expect(row?.happened_on).toBe(happenedOn.toISOString());
  });
  it("should parse CURRENT_TIMESTAMP strings as UTC", async () => {
    const tableName = adapter.namingStrategy.tableName("events", "namespace");

    const createUow = adapter.createUnitOfWork(testSchema, "namespace", "create-utc-event");
    createUow.create("events", {
      name: "UTC Timestamp",
      happened_on: new Date("2024-06-15T00:00:00.000Z"),
      payload: { level: "info", tags: ["sqlite", "utc"] },
      big_score: 42n,
    });
    await createUow.executeMutations();

    sqliteDatabase
      .prepare(`UPDATE ${tableName} SET created_at = ? WHERE name = ?`)
      .run("2024-06-15 14:30:00", "UTC Timestamp");

    const [[event]] = await adapter
      .createUnitOfWork(testSchema, "namespace", "get-utc-event")
      .find("events", (b) =>
        b.whereIndex("events_name_idx", (eb) => eb("name", "=", "UTC Timestamp")),
      )
      .executeRetrieve();

    expect(event.created_at).toBeInstanceOf(Date);
    assert(event.created_at.toISOString() === "2024-06-15T14:30:00.000Z");
  });

  it("should roundtrip BigInt when sqlite returns bigint values", async () => {
    sqliteDatabase.defaultSafeIntegers(true);
    const safeIntegerLimit = BigInt(Number.MAX_SAFE_INTEGER);
    const bigScore = safeIntegerLimit + 42n;

    try {
      const createUow = adapter.createUnitOfWork(
        testSchema,
        "namespace",
        "create-safe-bigint-event",
      );
      createUow.create("events", {
        name: "Safe BigInt",
        happened_on: new Date("2024-06-17T00:00:00.000Z"),
        payload: { level: "info", tags: ["sqlite", "safe-bigint"] },
        big_score: bigScore,
      });
      await createUow.executeMutations();

      const [[event]] = await adapter
        .createUnitOfWork(testSchema, "namespace", "get-safe-bigint-event")
        .find("events", (b) =>
          b.whereIndex("events_name_idx", (eb) => eb("name", "=", "Safe BigInt")),
        )
        .executeRetrieve();

      expect(event.big_score).toBe(bigScore);
    } finally {
      sqliteDatabase.defaultSafeIntegers(false);
    }
  });

  it("should throw when sqlite returns unsafe BigInt numbers", async () => {
    sqliteDatabase.defaultSafeIntegers(false);
    const unsafeBigScore = BigInt(Number.MAX_SAFE_INTEGER) + 2n;

    try {
      const createUow = adapter.createUnitOfWork(testSchema, "namespace", "create-unsafe-event");
      createUow.create("events", {
        name: "Unsafe BigInt",
        happened_on: new Date("2024-06-16T00:00:00.000Z"),
        payload: { level: "warn", tags: ["sqlite", "unsafe-bigint"] },
        big_score: unsafeBigScore,
      });
      await createUow.executeMutations();

      await expect(
        adapter
          .createUnitOfWork(testSchema, "namespace", "get-unsafe-event")
          .find("events", (b) =>
            b.whereIndex("events_name_idx", (eb) => eb("name", "=", "Unsafe BigInt")),
          )
          .executeRetrieve(),
      ).rejects.toThrow(/Number\.MAX_SAFE_INTEGER/);
    } finally {
      sqliteDatabase.defaultSafeIntegers(false);
    }
  });
});
