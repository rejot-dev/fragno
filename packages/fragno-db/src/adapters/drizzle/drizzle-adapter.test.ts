import { describe, expect, it } from "vitest";
import { column, idColumn, schema } from "../../schema/create";
import { DrizzleAdapter } from "./drizzle-adapter";

describe("DrizzleAdapter", () => {
  const testSchema = schema((s) => {
    return s.addTable("users", (t) => {
      return t.addColumn("id", idColumn()).addColumn("name", column("string"));
    });
  });

  it("should generate schema with settings table for postgresql", () => {
    const adapter = new DrizzleAdapter({
      db: {},
      provider: "postgresql",
    });

    const generator = adapter.createSchemaGenerator([{ schema: testSchema, namespace: "test" }]);
    const result = generator.generateSchema({ path: "schema.ts" });

    expect(result.path).toBe("schema.ts");
    expect(result.schema).toMatchInlineSnapshot(`
      "import { pgTable, varchar, text, bigserial, integer } from "drizzle-orm/pg-core"
      import { createId } from "@fragno-dev/db/id"

      // ============================================================================
      // Fragment: test
      // ============================================================================

      export const users_test = pgTable("users_test", {
        id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
        name: text("name").notNull(),
        _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
        _version: integer("_version").notNull().default(0)
      })

      export const test_schema = {
        users_test: users_test,
        users: users_test,
        schemaVersion: 1
      }"
    `);
  });

  it("should generate schema with settings table for sqlite", () => {
    const adapter = new DrizzleAdapter({
      db: {},
      provider: "sqlite",
    });

    const generator = adapter.createSchemaGenerator([{ schema: testSchema, namespace: "test" }]);
    const result = generator.generateSchema({ path: "schema.ts" });

    expect(result.path).toBe("schema.ts");
    expect(result.schema).toMatchInlineSnapshot(`
      "import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
      import { createId } from "@fragno-dev/db/id"

      // ============================================================================
      // Fragment: test
      // ============================================================================

      export const users_test = sqliteTable("users_test", {
        id: text("id").notNull().$defaultFn(() => createId()),
        name: text("name").notNull(),
        _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
        _version: integer("_version").notNull().default(0)
      })

      export const test_schema = {
        users_test: users_test,
        users: users_test,
        schemaVersion: 1
      }"
    `);
  });

  it("should use default path if not provided", () => {
    const adapter = new DrizzleAdapter({
      db: {},
      provider: "postgresql",
    });

    const generator = adapter.createSchemaGenerator([{ schema: testSchema, namespace: "myapp" }]);
    const result = generator.generateSchema();

    expect(result.path).toBe("fragno-schema.ts");
  });

  it("should preserve original schema tables", () => {
    const adapter = new DrizzleAdapter({
      db: {},
      provider: "postgresql",
    });

    const generator = adapter.createSchemaGenerator([{ schema: testSchema, namespace: "test" }]);
    const result = generator.generateSchema();

    // Original table should still be there
    expect(result.schema).toMatchInlineSnapshot(`
      "import { pgTable, varchar, text, bigserial, integer } from "drizzle-orm/pg-core"
      import { createId } from "@fragno-dev/db/id"

      // ============================================================================
      // Fragment: test
      // ============================================================================

      export const users_test = pgTable("users_test", {
        id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
        name: text("name").notNull(),
        _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
        _version: integer("_version").notNull().default(0)
      })

      export const test_schema = {
        users_test: users_test,
        users: users_test,
        schemaVersion: 1
      }"
    `);
  });
});
