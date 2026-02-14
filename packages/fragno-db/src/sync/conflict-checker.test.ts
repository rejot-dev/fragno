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
      _version integer,
      _shard text
    );`.compile(dialect),
  );

  await driver.executeQuery(
    sql`CREATE TABLE posts (
      id text,
      title text,
      userId integer,
      _internalId integer,
      _version integer,
      _shard text
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
      op text,
      _shard text
    );`.compile(dialect),
  );
};

describe("checkConflicts", () => {
  let database: InstanceType<typeof Database>;
  let dialect: SqliteDialect;
  let driver: SqlDriverAdapter;
  const insertMutation = async ({
    id,
    schema: schemaName,
    table,
    externalId,
    entryVersionstamp = nextVersionstamp,
    shard,
  }: {
    id: string;
    schema: string;
    table: string;
    externalId: string;
    entryVersionstamp?: string;
    shard?: string | null;
  }) => {
    await driver.executeQuery(
      sql`INSERT INTO fragno_db_outbox_mutations (
            id, entryVersionstamp, mutationVersionstamp, uowId, schema, "table", externalId, op, _shard
          ) VALUES (
            ${id}, ${entryVersionstamp}, ${entryVersionstamp}, ${`uow_${id}`}, ${schemaName}, ${table}, ${externalId}, ${"update"}, ${shard ?? null}
          );`.compile(dialect),
    );
  };

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

    await insertMutation({
      id: "m1",
      schema: "",
      table: "users",
      externalId: "u1",
    });

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

    await insertMutation({
      id: "m2",
      schema: "",
      table: "users",
      externalId: "u1",
    });

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
    await insertMutation({
      id: "m3",
      schema: "",
      table: "users",
      externalId: "u1",
    });

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

  test("ignores empty externalIds in read/write keys", async () => {
    await insertMutation({
      id: "m4",
      schema: "",
      table: "users",
      externalId: "u1",
    });

    const hasConflict = await checkConflicts(
      {
        baseVersionstamp,
        readKeys: [{ schema: "", table: "users", externalId: "   " }],
        writeKeys: [{ schema: "", table: "users", externalId: "" }],
        readScopes: [],
      },
      { driver, driverConfig: new BetterSQLite3DriverConfig() },
    );

    expect(hasConflict).toBe(false);
  });

  test("detects conflicts from write keys", async () => {
    await insertMutation({
      id: "m5",
      schema: "",
      table: "users",
      externalId: "u1",
    });

    const hasConflict = await checkConflicts(
      {
        baseVersionstamp,
        readKeys: [],
        writeKeys: [{ schema: "", table: "users", externalId: "u1" }],
        readScopes: [],
      },
      { driver, driverConfig: new BetterSQLite3DriverConfig() },
    );

    expect(hasConflict).toBe(true);
  });

  test("skips mutations at the base versionstamp", async () => {
    await insertMutation({
      id: "m6",
      schema: "",
      table: "users",
      externalId: "u1",
      entryVersionstamp: baseVersionstamp,
    });

    const hasConflict = await checkConflicts(
      {
        baseVersionstamp,
        readKeys: [{ schema: "", table: "users", externalId: "u1" }],
        writeKeys: [],
        readScopes: [],
      },
      { driver, driverConfig: new BetterSQLite3DriverConfig() },
    );

    expect(hasConflict).toBe(false);
  });

  test("defaults unknown read strategy to conflict", async () => {
    await insertMutation({
      id: "m7",
      schema: "",
      table: "users",
      externalId: "u1",
    });

    const hasConflict = await checkConflicts(
      {
        baseVersionstamp,
        readKeys: [],
        writeKeys: [],
        readScopes: [],
        unknownReads: [{ schema: "", table: "posts" }],
      },
      { driver, driverConfig: new BetterSQLite3DriverConfig() },
    );

    expect(hasConflict).toBe(true);
  });

  test("unknownReadStrategy table only checks matching tables", async () => {
    await insertMutation({
      id: "m8",
      schema: "",
      table: "users",
      externalId: "u1",
    });

    const shouldSkip = await checkConflicts(
      {
        baseVersionstamp,
        readKeys: [],
        writeKeys: [],
        readScopes: [],
        unknownReads: [{ schema: "", table: "posts" }],
        unknownReadStrategy: "table",
      },
      { driver, driverConfig: new BetterSQLite3DriverConfig() },
    );

    const shouldConflict = await checkConflicts(
      {
        baseVersionstamp,
        readKeys: [],
        writeKeys: [],
        readScopes: [],
        unknownReads: [{ schema: "", table: "users" }],
        unknownReadStrategy: "table",
      },
      { driver, driverConfig: new BetterSQLite3DriverConfig() },
    );

    expect(shouldSkip).toBe(false);
    expect(shouldConflict).toBe(true);
  });

  test("read scopes without matching rows do not conflict", async () => {
    await driver.executeQuery(
      sql`INSERT INTO posts (id, title, userId, _internalId, _version)
          VALUES (${"p1"}, ${"Hello"}, 1, 10, 0);`.compile(dialect),
    );

    await insertMutation({
      id: "m9",
      schema: "",
      table: "posts",
      externalId: "p1",
    });

    const options = buildFindOptions(testSchema.tables.posts, {
      where: (eb) => eb("title", "=", "Missing"),
    });

    if (!options) {
      throw new Error("Expected options to compile.");
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

    expect(hasConflict).toBe(false);
  });

  test("returns conflict when any read scope matches", async () => {
    await driver.executeQuery(
      sql`INSERT INTO posts (id, title, userId, _internalId, _version)
          VALUES (${"p1"}, ${"Hello"}, 1, 10, 0);`.compile(dialect),
    );

    await insertMutation({
      id: "m10",
      schema: "",
      table: "posts",
      externalId: "p1",
    });

    const noMatch = buildFindOptions(testSchema.tables.posts, {
      where: (eb) => eb("title", "=", "Missing"),
    });
    const match = buildFindOptions(testSchema.tables.posts, {
      where: (eb) => eb("title", "=", "Hello"),
    });

    if (!noMatch || !match) {
      throw new Error("Expected options to compile.");
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
            condition: noMatch.where,
            joins: noMatch.join,
          },
          {
            schema: "",
            table: testSchema.tables.posts,
            indexName: "primary",
            condition: match.where,
            joins: match.join,
          },
        ],
      },
      { driver, driverConfig: new BetterSQLite3DriverConfig() },
    );

    expect(hasConflict).toBe(true);
  });

  test("does not conflict on schema mismatch", async () => {
    await insertMutation({
      id: "m11",
      schema: "other",
      table: "users",
      externalId: "u1",
    });

    const hasConflict = await checkConflicts(
      {
        baseVersionstamp,
        readKeys: [{ schema: "", table: "users", externalId: "u1" }],
        writeKeys: [],
        readScopes: [],
      },
      { driver, driverConfig: new BetterSQLite3DriverConfig() },
    );

    expect(hasConflict).toBe(false);
  });

  test("scopes key conflicts to the current shard in row mode", async () => {
    await insertMutation({
      id: "m12",
      schema: "",
      table: "users",
      externalId: "u1",
      shard: "alpha",
    });

    const hasConflict = await checkConflicts(
      {
        baseVersionstamp,
        readKeys: [{ schema: "", table: "users", externalId: "u1" }],
        writeKeys: [],
        readScopes: [],
      },
      {
        driver,
        driverConfig: new BetterSQLite3DriverConfig(),
        shardingStrategy: { mode: "row" },
        shard: "beta",
        shardScope: "scoped",
      },
    );

    expect(hasConflict).toBe(false);
  });

  test("does not filter conflicts when shardScope is global", async () => {
    await insertMutation({
      id: "m13",
      schema: "",
      table: "users",
      externalId: "u1",
      shard: "alpha",
    });

    const hasConflict = await checkConflicts(
      {
        baseVersionstamp,
        readKeys: [{ schema: "", table: "users", externalId: "u1" }],
        writeKeys: [],
        readScopes: [],
      },
      {
        driver,
        driverConfig: new BetterSQLite3DriverConfig(),
        shardingStrategy: { mode: "row" },
        shard: "beta",
        shardScope: "global",
      },
    );

    expect(hasConflict).toBe(true);
  });

  test("read scopes are filtered by shard in row mode", async () => {
    await driver.executeQuery(
      sql`INSERT INTO posts (id, title, userId, _internalId, _version, _shard)
          VALUES (${"p1"}, ${"Hello"}, 1, 10, 0, ${"alpha"});`.compile(dialect),
    );

    await insertMutation({
      id: "m14",
      schema: "",
      table: "posts",
      externalId: "p1",
      shard: "beta",
    });

    const options = buildFindOptions(testSchema.tables.posts, {
      where: (eb) => eb("title", "=", "Hello"),
    });

    if (!options) {
      throw new Error("Expected options to compile.");
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
      {
        driver,
        driverConfig: new BetterSQLite3DriverConfig(),
        shardingStrategy: { mode: "row" },
        shard: "beta",
        shardScope: "scoped",
      },
    );

    expect(hasConflict).toBe(false);
  });
});
