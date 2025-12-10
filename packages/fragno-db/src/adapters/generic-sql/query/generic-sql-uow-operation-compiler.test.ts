import { describe, test, expect } from "vitest";
import { GenericSQLUOWOperationCompiler } from "./generic-sql-uow-operation-compiler";
import { BetterSQLite3DriverConfig } from "../driver-config";
import { schema, column, idColumn, referenceColumn, FragnoId } from "../../../schema/create";

// Test schema
const testSchema = schema((s) => {
  return s
    .addTable("users", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("email", column("string"))
        .addColumn("age", column("integer").nullable());
    })
    .addTable("posts", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("title", column("string"))
        .addColumn("content", column("string"))
        .addColumn("userId", referenceColumn());
    });
});

describe("GenericSQLUOWOperationCompiler", () => {
  const driverConfig = new BetterSQLite3DriverConfig();

  test("compileCount operation", () => {
    const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

    const result = compiler.compileCount({
      type: "count",
      schema: testSchema,
      table: testSchema.tables.users,
      indexName: "primary",
      options: {
        useIndex: "primary",
      },
    });

    expect(result).not.toBeNull();
    expect(result!.sql).toMatchInlineSnapshot(`"select count(*) as "count" from "users""`);
  });

  test("compileCount with where clause", () => {
    const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

    const result = compiler.compileCount({
      type: "count",
      schema: testSchema,
      table: testSchema.tables.users,
      indexName: "primary",
      options: {
        useIndex: "primary",
        where: (eb) => eb("age", ">", 18),
      },
    });

    expect(result).not.toBeNull();
    expect(result!.sql).toMatchInlineSnapshot(
      `"select count(*) as "count" from "users" where "users"."age" > ?"`,
    );
  });

  test("compileFind operation", () => {
    const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

    const result = compiler.compileFind({
      type: "find",
      schema: testSchema,
      table: testSchema.tables.users,
      indexName: "primary",
      options: {
        useIndex: "primary",
        select: true,
        pageSize: 10,
      },
    });

    expect(result).not.toBeNull();
    expect(result!.sql).toMatchInlineSnapshot(
      `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" limit ?"`,
    );
  });

  test("compileCreate operation", () => {
    const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

    const result = compiler.compileCreate({
      type: "create",
      schema: testSchema,
      table: "users",
      values: {
        name: "John",
        email: "john@example.com",
        age: 30,
      },
      generatedExternalId: "user123",
    });

    expect(result).not.toBeNull();
    expect(result!.query.sql).toMatchInlineSnapshot(
      `"insert into "users" ("id", "name", "email", "age") values (?, ?, ?, ?) returning "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."_internalId" as "_internalId", "users"."_version" as "_version""`,
    );
    expect(result!.expectedAffectedRows).toBeNull();
  });

  test("compileUpdate operation", () => {
    const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

    const result = compiler.compileUpdate({
      type: "update",
      schema: testSchema,
      table: "users",
      id: "user123",
      checkVersion: false,
      set: {
        name: "Jane",
      },
    });

    expect(result).not.toBeNull();
    expect(result!.query.sql).toMatchInlineSnapshot(
      `"update "users" set "name" = ?, "_version" = COALESCE(_version, 0) + 1 where "users"."id" = ?"`,
    );
    expect(result!.expectedAffectedRows).toBeNull();
  });

  test("compileUpdate with version check", () => {
    const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

    const result = compiler.compileUpdate({
      type: "update",
      schema: testSchema,
      table: "users",
      id: new FragnoId({ externalId: "user123", internalId: 1n, version: 5 }),
      checkVersion: true,
      set: {
        name: "Jane",
      },
    });

    expect(result).not.toBeNull();
    expect(result!.query.sql).toMatchInlineSnapshot(
      `"update "users" set "name" = ?, "_version" = COALESCE(_version, 0) + 1 where ("users"."id" = ? and "users"."_version" = ?)"`,
    );
    expect(result!.expectedAffectedRows).toBe(1);
  });

  test("compileDelete operation", () => {
    const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

    const result = compiler.compileDelete({
      type: "delete",
      schema: testSchema,
      table: "users",
      id: "user123",
      checkVersion: false,
    });

    expect(result).not.toBeNull();
    expect(result!.query.sql).toMatchInlineSnapshot(`"delete from "users" where "users"."id" = ?"`);
    expect(result!.expectedAffectedRows).toBeNull();
  });

  test("compileCheck operation", () => {
    const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

    const result = compiler.compileCheck({
      type: "check",
      schema: testSchema,
      table: "users",
      id: new FragnoId({ externalId: "user123", internalId: 1n, version: 5 }),
    });

    expect(result).not.toBeNull();
    expect(result!.query.sql).toMatchInlineSnapshot(
      `"select 1 as "exists" from "users" where ("users"."id" = ? and "users"."_version" = ?) limit ?"`,
    );
    expect(result!.expectedReturnedRows).toBe(1);
  });
});
