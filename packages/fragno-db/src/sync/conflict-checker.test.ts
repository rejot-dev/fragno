import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { SqliteDialect } from "kysely";
import Database from "better-sqlite3";
import { SqlDriverAdapter } from "../sql-driver/sql-driver-adapter";
import { sql } from "../sql-driver/sql";
import { BetterSQLite3DriverConfig } from "../adapters/generic-sql/driver-config";
import { schema, column, idColumn, referenceColumn } from "../schema/create";
import { buildFindOptions } from "../query/orm/orm";
import { checkConflicts } from "./conflict-checker";

const testSchema = schema("test", (s) => {
  return s
    .addTable("users", (t) => {
      return t.addColumn("id", idColumn()).addColumn("name", column("string"));
    })
    .addTable("posts", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("title", column("string"))
        .addColumn("userId", referenceColumn());
    })
    .addReference("author", {
      type: "one",
      from: { table: "posts", column: "userId" },
      to: { table: "users", column: "id" },
    });
});

const baseVersionstamp = "000000000000000000000001";
const nextVersionstamp = "000000000000000000000002";

const createDriver = () => {
  const database = new Database(":memory:");
  const dialect = new SqliteDialect({ database });
  const driver = new SqlDriverAdapter(dialect);

  return { database, dialect, driver };
};

const setupTables = async (driver: SqlDriverAdapter, dialect: SqliteDialect) => {
  await driver.executeQuery(
    sql`CREATE TABLE users (
      id text,
      name text,
      _internalId integer,
      _version integer
    );`.compile(dialect),
  );

  await driver.executeQuery(
    sql`CREATE TABLE posts (
      id text,
      title text,
      userId integer,
      _internalId integer,
      _version integer
    );`.compile(dialect),
  );

  await driver.executeQuery(
    sql`CREATE TABLE fragno_db_outbox_mutations (
      id text,
      entryVersionstamp text,
      mutationVersionstamp text,
      uowId text,
      schema text,
      "table" text,
      externalId text,
      op text
    );`.compile(dialect),
  );
};

describe("checkConflicts", () => {
  let database: InstanceType<typeof Database>;
  let dialect: SqliteDialect;
  let driver: SqlDriverAdapter;

  beforeEach(async () => {
    const setup = createDriver();
    database = setup.database;
    dialect = setup.dialect;
    driver = setup.driver;
    await setupTables(driver, dialect);
  });

  afterEach(async () => {
    await driver.destroy();
    database.close();
  });

  test("detects conflicts from read keys", async () => {
    await driver.executeQuery(
      sql`INSERT INTO users (id, name, _internalId, _version)
          VALUES (${"u1"}, ${"Ava"}, 1, 0);`.compile(dialect),
    );

    await driver.executeQuery(
      sql`INSERT INTO fragno_db_outbox_mutations (
            id, entryVersionstamp, mutationVersionstamp, uowId, schema, "table", externalId, op
          ) VALUES (
            ${"m1"}, ${nextVersionstamp}, ${nextVersionstamp}, ${"uow1"}, ${""}, ${"users"}, ${"u1"}, ${"update"}
          );`.compile(dialect),
    );

    const hasConflict = await checkConflicts(
      {
        baseVersionstamp,
        readKeys: [{ schema: "", table: "users", externalId: "u1" }],
        writeKeys: [],
        readScopes: [],
      },
      { driver, driverConfig: new BetterSQLite3DriverConfig() },
    );

    expect(hasConflict).toBe(true);
  });

  test("detects conflicts from read scopes with joins", async () => {
    await driver.executeQuery(
      sql`INSERT INTO users (id, name, _internalId, _version)
          VALUES (${"u1"}, ${"Ava"}, 1, 0);`.compile(dialect),
    );

    await driver.executeQuery(
      sql`INSERT INTO posts (id, title, userId, _internalId, _version)
          VALUES (${"p1"}, ${"Hello"}, 1, 10, 0);`.compile(dialect),
    );

    await driver.executeQuery(
      sql`INSERT INTO fragno_db_outbox_mutations (
            id, entryVersionstamp, mutationVersionstamp, uowId, schema, "table", externalId, op
          ) VALUES (
            ${"m2"}, ${nextVersionstamp}, ${nextVersionstamp}, ${"uow2"}, ${""}, ${"users"}, ${"u1"}, ${"update"}
          );`.compile(dialect),
    );

    const options = buildFindOptions(testSchema.tables.posts, {
      where: (eb) => eb("title", "=", "Hello"),
      join: (jb) => {
        jb["author"]();
      },
    });

    if (!options) {
      throw new Error("Expected join options to compile.");
    }

    const hasConflict = await checkConflicts(
      {
        baseVersionstamp,
        readKeys: [],
        writeKeys: [],
        readScopes: [
          {
            schema: "",
            table: testSchema.tables.posts,
            indexName: "primary",
            condition: options.where,
            joins: options.join,
          },
        ],
      },
      { driver, driverConfig: new BetterSQLite3DriverConfig() },
    );

    expect(hasConflict).toBe(true);
  });

  test("honors unknownReadStrategy ignore", async () => {
    await driver.executeQuery(
      sql`INSERT INTO fragno_db_outbox_mutations (
            id, entryVersionstamp, mutationVersionstamp, uowId, schema, "table", externalId, op
          ) VALUES (
            ${"m3"}, ${nextVersionstamp}, ${nextVersionstamp}, ${"uow3"}, ${""}, ${"users"}, ${"u1"}, ${"update"}
          );`.compile(dialect),
    );

    const hasConflict = await checkConflicts(
      {
        baseVersionstamp,
        readKeys: [],
        writeKeys: [],
        readScopes: [],
        unknownReads: [{ schema: "", table: "users" }],
        unknownReadStrategy: "ignore",
      },
      { driver, driverConfig: new BetterSQLite3DriverConfig() },
    );

    expect(hasConflict).toBe(false);
  });
});
