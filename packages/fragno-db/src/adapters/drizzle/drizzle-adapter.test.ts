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

    const generator = adapter.createSchemaGenerator(testSchema, "test");
    const result = generator.generateSchema({ path: "schema.ts" });

    expect(result.path).toBe("schema.ts");
    expect(result.schema).toMatchInlineSnapshot(`
      "import { pgTable, varchar, text, bigserial, integer, uniqueIndex } from "drizzle-orm/pg-core"
      import { createId } from "@fragno-dev/db/id"

      export const users = pgTable("users", {
        id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
        name: text("name").notNull(),
        _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
        _version: integer("_version").notNull().default(0)
      })

      export const fragno_db_settings = pgTable("fragno_db_settings", {
        id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
        key: text("key").notNull(),
        value: text("value").notNull().default("1"),
        _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
        _version: integer("_version").notNull().default(0)
      }, (table) => [
        uniqueIndex("unique_key").on(table.key)
      ])"
    `);
  });

  it("should generate schema with settings table for sqlite", () => {
    const adapter = new DrizzleAdapter({
      db: {},
      provider: "sqlite",
    });

    const generator = adapter.createSchemaGenerator(testSchema, "test");
    const result = generator.generateSchema({ path: "schema.ts" });

    expect(result.path).toBe("schema.ts");
    expect(result.schema).toMatchInlineSnapshot(`
      "import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core"
      import { createId } from "@fragno-dev/db/id"

      export const users = sqliteTable("users", {
        id: text("id").notNull().$defaultFn(() => createId()),
        name: text("name").notNull(),
        _internalId: integer("_internalId").primaryKey().autoincrement().notNull(),
        _version: integer("_version").notNull().default(0)
      })

      export const fragno_db_settings = sqliteTable("fragno_db_settings", {
        id: text("id").notNull().$defaultFn(() => createId()),
        key: text("key").notNull(),
        value: text("value").notNull().default("1"),
        _internalId: integer("_internalId").primaryKey().autoincrement().notNull(),
        _version: integer("_version").notNull().default(0)
      }, (table) => [
        uniqueIndex("unique_key").on(table.key)
      ])"
    `);
  });

  it("should use default path if not provided", () => {
    const adapter = new DrizzleAdapter({
      db: {},
      provider: "postgresql",
    });

    const generator = adapter.createSchemaGenerator(testSchema, "myapp");
    const result = generator.generateSchema();

    expect(result.path).toBe("drizzle-schema-myapp.ts");
  });

  it("should preserve original schema tables", () => {
    const adapter = new DrizzleAdapter({
      db: {},
      provider: "postgresql",
    });

    const generator = adapter.createSchemaGenerator(testSchema, "test");
    const result = generator.generateSchema();

    // Original table should still be there
    expect(result.schema).toMatchInlineSnapshot(`
      "import { pgTable, varchar, text, bigserial, integer, uniqueIndex } from "drizzle-orm/pg-core"
      import { createId } from "@fragno-dev/db/id"

      export const users = pgTable("users", {
        id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
        name: text("name").notNull(),
        _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
        _version: integer("_version").notNull().default(0)
      })

      export const fragno_db_settings = pgTable("fragno_db_settings", {
        id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
        key: text("key").notNull(),
        value: text("value").notNull().default("1"),
        _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
        _version: integer("_version").notNull().default(0)
      }, (table) => [
        uniqueIndex("unique_key").on(table.key)
      ])"
    `);
  });
});
