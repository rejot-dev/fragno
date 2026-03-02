import { describe, expect, it } from "vitest";
import { column, idColumn, referenceColumn, schema } from "../schema/create";
import { generateDrizzleSchema } from "./drizzle";
import { internalSchema } from "../fragments/internal-fragment";

describe("generateDrizzleSchema", () => {
  const testSchema = schema("test", (s) => {
    return s
      .addTable("users", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("email", column("string"))
          .addColumn("age", column("integer").nullable())
          .createIndex("idx_email", ["email"], { unique: true })
          .createIndex("idx_name", ["name"]);
      })
      .addTable("posts", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("title", column("string"))
          .addColumn("content", column("string"))
          .addColumn("userId", referenceColumn())
          .addColumn("viewCount", column("integer").defaultTo(0))
          .createIndex("idx_user", ["userId"])
          .createIndex("idx_title", ["title"]);
      })
      .addReference("author", {
        type: "one",
        from: { table: "posts", column: "userId" },
        to: { table: "users", column: "id" },
      });
  });

  it("should reflect alterColumn nullable changes", () => {
    const alteredSchema = schema("altered", (s) => {
      return s
        .addTable("users", (t) => {
          return t.addColumn("id", idColumn()).addColumn("name", column("string"));
        })
        .alterTable("users", (t) => {
          return t.alterColumn("name").nullable();
        });
    });

    const generated = generateDrizzleSchema(
      [{ namespace: "altered", schema: alteredSchema }],
      "postgresql",
    );

    expect(generated).toContain(`name: text("name")`);
    expect(generated).not.toContain(`name: text("name").notNull()`);
  });

  describe("postgresql", () => {
    it("should generate PostgreSQL schema", () => {
      const generated = generateDrizzleSchema(
        [{ namespace: "test", schema: testSchema }],
        "postgresql",
      );
      expect(generated).toMatchInlineSnapshot(`
        "import { pgSchema, varchar, text, integer, bigserial, uniqueIndex, index, bigint, foreignKey } from "drizzle-orm/pg-core"
        import { createId } from "@fragno-dev/db/id"
        import { relations } from "drizzle-orm"

        // ============================================================================
        // Fragment: test
        // ============================================================================

        const schema_test = pgSchema("test");

        export const users_test = schema_test.table("users", {
          id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
          name: text("name").notNull(),
          email: text("email").notNull(),
          age: integer("age"),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          uniqueIndex("idx_email").on(table.email),
          index("idx_name").on(table.name)
        ])

        export const posts_test = schema_test.table("posts", {
          id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
          title: text("title").notNull(),
          content: text("content").notNull(),
          userId: bigint("userId", { mode: "number" }).notNull(),
          viewCount: integer("viewCount").notNull().default(0),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          foreignKey({
            columns: [table.userId],
            foreignColumns: [users_test._internalId],
            name: "fk_posts_users_author"
          }),
          index("idx_user").on(table.userId),
          index("idx_title").on(table.title)
        ])

        export const users_testRelations = relations(users_test, ({ many }) => ({
          postsList: many(posts_test, {
            relationName: "posts_users"
          })
        }));

        export const posts_testRelations = relations(posts_test, ({ one }) => ({
          author: one(users_test, {
            relationName: "posts_users",
            fields: [posts_test.userId],
            references: [users_test._internalId]
          })
        }));

        export const test_schema = {
          users_test: users_test,
          users_testRelations: users_testRelations,
          users: users_test,
          usersRelations: users_testRelations,
          posts_test: posts_test,
          posts_testRelations: posts_testRelations,
          posts: posts_test,
          postsRelations: posts_testRelations,
          schemaVersion: 3
        }"
      `);
    });
  });

  describe("mysql", () => {
    it("should generate MySQL schema", () => {
      const generated = generateDrizzleSchema([{ namespace: "test", schema: testSchema }], "mysql");
      expect(generated).toMatchInlineSnapshot(`
        "import { mysqlTable, varchar, text, int, bigint, uniqueIndex, index, foreignKey } from "drizzle-orm/mysql-core"
        import { createId } from "@fragno-dev/db/id"
        import { relations } from "drizzle-orm"

        // ============================================================================
        // Fragment: test
        // ============================================================================

        export const users_test = mysqlTable("users_test", {
          id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
          name: text("name").notNull(),
          email: text("email").notNull(),
          age: int("age"),
          _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
          _version: int("_version").notNull().default(0)
        }, (table) => [
          uniqueIndex("uidx_users_idx_email_test_3d974845").on(table.email),
          index("idx_users_idx_name_test_7f36c497").on(table.name)
        ])

        export const posts_test = mysqlTable("posts_test", {
          id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
          title: text("title").notNull(),
          content: text("content").notNull(),
          userId: bigint("userId", { mode: "number" }).notNull(),
          viewCount: int("viewCount").notNull().default(0),
          _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
          _version: int("_version").notNull().default(0)
        }, (table) => [
          foreignKey({
            columns: [table.userId],
            foreignColumns: [users_test._internalId],
            name: "fk_posts_users_author_test_8d48035c"
          }),
          index("idx_posts_idx_user_test_4a5c5c19").on(table.userId),
          index("idx_posts_idx_title_test_00e97ff4").on(table.title)
        ])

        export const users_testRelations = relations(users_test, ({ many }) => ({
          postsList: many(posts_test, {
            relationName: "posts_users"
          })
        }));

        export const posts_testRelations = relations(posts_test, ({ one }) => ({
          author: one(users_test, {
            relationName: "posts_users",
            fields: [posts_test.userId],
            references: [users_test._internalId]
          })
        }));

        export const test_schema = {
          users_test: users_test,
          users_testRelations: users_testRelations,
          users: users_test,
          usersRelations: users_testRelations,
          posts_test: posts_test,
          posts_testRelations: posts_testRelations,
          posts: posts_test,
          postsRelations: posts_testRelations,
          schemaVersion: 3
        }"
      `);
    });
  });

  describe("sqlite", () => {
    it("should generate SQLite schema", () => {
      const generated = generateDrizzleSchema(
        [{ namespace: "test", schema: testSchema }],
        "sqlite",
      );
      expect(generated).toMatchInlineSnapshot(`
        "import { sqliteTable, text, integer, uniqueIndex, index, foreignKey } from "drizzle-orm/sqlite-core"
        import { createId } from "@fragno-dev/db/id"
        import { relations } from "drizzle-orm"

        // ============================================================================
        // Fragment: test
        // ============================================================================

        export const users_test = sqliteTable("users_test", {
          id: text("id").notNull().unique().$defaultFn(() => createId()),
          name: text("name").notNull(),
          email: text("email").notNull(),
          age: integer("age"),
          _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          uniqueIndex("uidx_users_idx_email_test_3d974845").on(table.email),
          index("idx_users_idx_name_test_7f36c497").on(table.name),
          uniqueIndex("uidx_users_idx_users_external_id_test_8eaf053f").on(table.id)
        ])

        export const posts_test = sqliteTable("posts_test", {
          id: text("id").notNull().unique().$defaultFn(() => createId()),
          title: text("title").notNull(),
          content: text("content").notNull(),
          userId: integer("userId").notNull(),
          viewCount: integer("viewCount").notNull().default(0),
          _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          foreignKey({
            columns: [table.userId],
            foreignColumns: [users_test._internalId],
            name: "fk_posts_users_author_test_8d48035c"
          }),
          index("idx_posts_idx_user_test_4a5c5c19").on(table.userId),
          index("idx_posts_idx_title_test_00e97ff4").on(table.title),
          uniqueIndex("uidx_posts_idx_posts_external_id_test_80487638").on(table.id)
        ])

        export const users_testRelations = relations(users_test, ({ many }) => ({
          postsList: many(posts_test, {
            relationName: "posts_users"
          })
        }));

        export const posts_testRelations = relations(posts_test, ({ one }) => ({
          author: one(users_test, {
            relationName: "posts_users",
            fields: [posts_test.userId],
            references: [users_test._internalId]
          })
        }));

        export const test_schema = {
          users_test: users_test,
          users_testRelations: users_testRelations,
          users: users_test,
          usersRelations: users_testRelations,
          posts_test: posts_test,
          posts_testRelations: posts_testRelations,
          posts: posts_test,
          postsRelations: posts_testRelations,
          schemaVersion: 3
        }"
      `);
    });
  });

  describe("default values", () => {
    it("should handle runtime default values", () => {
      const timestampSchema = schema("timestamp", (s) => {
        return s.addTable("events", (t) => {
          return t.addColumn("id", idColumn()).addColumn(
            "createdAt",
            column("timestamp").defaultTo$((b) => b.now()),
          );
        });
      });

      const generated = generateDrizzleSchema(
        [{ namespace: "test", schema: timestampSchema }],
        "postgresql",
      );
      expect(generated).toMatchInlineSnapshot(`
        "import { pgSchema, varchar, timestamp, bigserial, integer } from "drizzle-orm/pg-core"
        import { createId } from "@fragno-dev/db/id"

        // ============================================================================
        // Fragment: test
        // ============================================================================

        const schema_test = pgSchema("test");

        export const events_test = schema_test.table("events", {
          id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
          createdAt: timestamp("createdAt").notNull().$defaultFn(() => new Date()),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        })

        export const test_schema = {
          events_test: events_test,
          events: events_test,
          schemaVersion: 1
        }"
      `);
    });

    it("should handle database-level default values", () => {
      const timestampSchema = schema("timestamp", (s) => {
        return s.addTable("events", (t) => {
          return t.addColumn("id", idColumn()).addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          );
        });
      });

      const generated = generateDrizzleSchema(
        [{ namespace: "test", schema: timestampSchema }],
        "postgresql",
      );
      expect(generated).toMatchInlineSnapshot(`
        "import { pgSchema, varchar, timestamp, bigserial, integer } from "drizzle-orm/pg-core"
        import { createId } from "@fragno-dev/db/id"

        // ============================================================================
        // Fragment: test
        // ============================================================================

        const schema_test = pgSchema("test");

        export const events_test = schema_test.table("events", {
          id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
          createdAt: timestamp("createdAt").notNull().defaultNow(),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        })

        export const test_schema = {
          events_test: events_test,
          events: events_test,
          schemaVersion: 1
        }"
      `);
    });
  });

  describe("binary columns", () => {
    it("should generate custom type for binary columns", () => {
      const binarySchema = schema("binary", (s) => {
        return s.addTable("files", (t) => {
          return t.addColumn("id", idColumn()).addColumn("data", column("binary"));
        });
      });

      const generated = generateDrizzleSchema(
        [{ namespace: "test", schema: binarySchema }],
        "postgresql",
      );
      expect(generated).toMatchInlineSnapshot(`
        "import { pgSchema, varchar, customType, bigserial, integer } from "drizzle-orm/pg-core"
        import { createId } from "@fragno-dev/db/id"
        const customBinary = customType<
          {
            data: Uint8Array;
            driverData: Buffer;
          }
        >({
          dataType() {
            return "bytea";
          },
          fromDriver(value) {
            return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          },
          toDriver(value) {
            return value instanceof Buffer? value : Buffer.from(value)
          }
        });

        // ============================================================================
        // Fragment: test
        // ============================================================================

        const schema_test = pgSchema("test");

        export const files_test = schema_test.table("files", {
          id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
          data: customBinary("data").notNull(),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        })

        export const test_schema = {
          files_test: files_test,
          files: files_test,
          schemaVersion: 1
        }"
      `);
    });
  });

  describe("many relations", () => {
    const oneToManySchema = schema("onetomany", (s) => {
      return s
        .addTable("users", (t) => {
          return t.addColumn("id", idColumn()).addColumn("name", column("string"));
        })
        .addTable("posts", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("title", column("string"))
            .addColumn("userId", referenceColumn())
            .createIndex("idx_user", ["userId"]);
        })
        .addReference("author", {
          type: "one",
          from: { table: "posts", column: "userId" },
          to: { table: "users", column: "id" },
        })
        .addReference("posts", {
          type: "many",
          from: { table: "users", column: "id" },
          to: { table: "posts", column: "userId" },
        });
    });

    it("should generate PostgreSQL schema with many relations", () => {
      const generated = generateDrizzleSchema(
        [{ namespace: "test", schema: oneToManySchema }],
        "postgresql",
      );
      expect(generated).toMatchInlineSnapshot(`
        "import { pgSchema, varchar, text, bigserial, integer, bigint, foreignKey, index } from "drizzle-orm/pg-core"
        import { createId } from "@fragno-dev/db/id"
        import { relations } from "drizzle-orm"

        // ============================================================================
        // Fragment: test
        // ============================================================================

        const schema_test = pgSchema("test");

        export const users_test = schema_test.table("users", {
          id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
          name: text("name").notNull(),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        })

        export const posts_test = schema_test.table("posts", {
          id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
          title: text("title").notNull(),
          userId: bigint("userId", { mode: "number" }).notNull(),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          foreignKey({
            columns: [table.userId],
            foreignColumns: [users_test._internalId],
            name: "fk_posts_users_author"
          }),
          index("idx_user").on(table.userId)
        ])

        export const users_testRelations = relations(users_test, ({ many }) => ({
          posts: many(posts_test, {
            relationName: "users_posts"
          }),
          postsList: many(posts_test, {
            relationName: "posts_users"
          })
        }));

        export const posts_testRelations = relations(posts_test, ({ one }) => ({
          author: one(users_test, {
            relationName: "posts_users",
            fields: [posts_test.userId],
            references: [users_test._internalId]
          })
        }));

        export const test_schema = {
          users_test: users_test,
          users_testRelations: users_testRelations,
          users: users_test,
          usersRelations: users_testRelations,
          posts_test: posts_test,
          posts_testRelations: posts_testRelations,
          posts: posts_test,
          postsRelations: posts_testRelations,
          schemaVersion: 4
        }"
      `);
    });

    it("should generate MySQL schema with many relations", () => {
      const generated = generateDrizzleSchema(
        [{ namespace: "test", schema: oneToManySchema }],
        "mysql",
      );
      expect(generated).toMatchInlineSnapshot(`
        "import { mysqlTable, varchar, text, bigint, int, foreignKey, index } from "drizzle-orm/mysql-core"
        import { createId } from "@fragno-dev/db/id"
        import { relations } from "drizzle-orm"

        // ============================================================================
        // Fragment: test
        // ============================================================================

        export const users_test = mysqlTable("users_test", {
          id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
          name: text("name").notNull(),
          _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
          _version: int("_version").notNull().default(0)
        })

        export const posts_test = mysqlTable("posts_test", {
          id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
          title: text("title").notNull(),
          userId: bigint("userId", { mode: "number" }).notNull(),
          _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
          _version: int("_version").notNull().default(0)
        }, (table) => [
          foreignKey({
            columns: [table.userId],
            foreignColumns: [users_test._internalId],
            name: "fk_posts_users_author_test_8d48035c"
          }),
          index("idx_posts_idx_user_test_4a5c5c19").on(table.userId)
        ])

        export const users_testRelations = relations(users_test, ({ many }) => ({
          posts: many(posts_test, {
            relationName: "users_posts"
          }),
          postsList: many(posts_test, {
            relationName: "posts_users"
          })
        }));

        export const posts_testRelations = relations(posts_test, ({ one }) => ({
          author: one(users_test, {
            relationName: "posts_users",
            fields: [posts_test.userId],
            references: [users_test._internalId]
          })
        }));

        export const test_schema = {
          users_test: users_test,
          users_testRelations: users_testRelations,
          users: users_test,
          usersRelations: users_testRelations,
          posts_test: posts_test,
          posts_testRelations: posts_testRelations,
          posts: posts_test,
          postsRelations: posts_testRelations,
          schemaVersion: 4
        }"
      `);
    });

    it("should generate SQLite schema with many relations", () => {
      const generated = generateDrizzleSchema(
        [{ namespace: "test", schema: oneToManySchema }],
        "sqlite",
      );
      expect(generated).toMatchInlineSnapshot(`
        "import { sqliteTable, text, integer, uniqueIndex, foreignKey, index } from "drizzle-orm/sqlite-core"
        import { createId } from "@fragno-dev/db/id"
        import { relations } from "drizzle-orm"

        // ============================================================================
        // Fragment: test
        // ============================================================================

        export const users_test = sqliteTable("users_test", {
          id: text("id").notNull().unique().$defaultFn(() => createId()),
          name: text("name").notNull(),
          _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          uniqueIndex("uidx_users_idx_users_external_id_test_8eaf053f").on(table.id)
        ])

        export const posts_test = sqliteTable("posts_test", {
          id: text("id").notNull().unique().$defaultFn(() => createId()),
          title: text("title").notNull(),
          userId: integer("userId").notNull(),
          _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          foreignKey({
            columns: [table.userId],
            foreignColumns: [users_test._internalId],
            name: "fk_posts_users_author_test_8d48035c"
          }),
          index("idx_posts_idx_user_test_4a5c5c19").on(table.userId),
          uniqueIndex("uidx_posts_idx_posts_external_id_test_80487638").on(table.id)
        ])

        export const users_testRelations = relations(users_test, ({ many }) => ({
          posts: many(posts_test, {
            relationName: "users_posts"
          }),
          postsList: many(posts_test, {
            relationName: "posts_users"
          })
        }));

        export const posts_testRelations = relations(posts_test, ({ one }) => ({
          author: one(users_test, {
            relationName: "posts_users",
            fields: [posts_test.userId],
            references: [users_test._internalId]
          })
        }));

        export const test_schema = {
          users_test: users_test,
          users_testRelations: users_testRelations,
          users: users_test,
          usersRelations: users_testRelations,
          posts_test: posts_test,
          posts_testRelations: posts_testRelations,
          posts: posts_test,
          postsRelations: posts_testRelations,
          schemaVersion: 4
        }"
      `);
    });

    it("should handle table with only many relations (no foreign keys)", () => {
      const manyOnlySchema = schema("manyonly", (s) => {
        return s
          .addTable("categories", (t) => {
            return t.addColumn("id", idColumn()).addColumn("name", column("string"));
          })
          .addTable("products", (t) => {
            return t
              .addColumn("id", idColumn())
              .addColumn("name", column("string"))
              .addColumn("categoryId", referenceColumn());
          })
          .addReference("products", {
            type: "many",
            from: { table: "categories", column: "id" },
            to: { table: "products", column: "categoryId" },
          });
      });

      const generated = generateDrizzleSchema(
        [{ namespace: "test", schema: manyOnlySchema }],
        "postgresql",
      );

      // Categories table should NOT have a constraint callback (no foreign keys, no indexes)
      const categoriesTableMatch = generated.match(
        /export const categories_test = schema_test\.table\("categories", \{[^}]+\}\)/,
      );
      expect(categoriesTableMatch).toBeTruthy();

      // Should have relations with many
      expect(generated).toContain(
        "export const categories_testRelations = relations(categories_test, ({ many }) => ({",
      );
      expect(generated).toContain("products: many(products_test");

      // Should have schema export
      expect(generated).toContain("export const test_schema = {");
      expect(generated).toMatchInlineSnapshot(`
        "import { pgSchema, varchar, text, bigserial, integer, bigint } from "drizzle-orm/pg-core"
        import { createId } from "@fragno-dev/db/id"
        import { relations } from "drizzle-orm"

        // ============================================================================
        // Fragment: test
        // ============================================================================

        const schema_test = pgSchema("test");

        export const categories_test = schema_test.table("categories", {
          id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
          name: text("name").notNull(),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        })

        export const products_test = schema_test.table("products", {
          id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
          name: text("name").notNull(),
          categoryId: bigint("categoryId", { mode: "number" }).notNull(),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        })

        export const categories_testRelations = relations(categories_test, ({ many }) => ({
          products: many(products_test, {
            relationName: "categories_products"
          })
        }));

        export const test_schema = {
          categories_test: categories_test,
          categories_testRelations: categories_testRelations,
          categories: categories_test,
          categoriesRelations: categories_testRelations,
          products_test: products_test,
          products: products_test,
          schemaVersion: 3
        }"
      `);
    });

    it("should handle self-referencing many relations", () => {
      const selfManySchema = schema("selfmany", (s) => {
        return s
          .addTable("category", (t) => {
            return t
              .addColumn("id", idColumn())
              .addColumn("name", column("string"))
              .addColumn("parentId", referenceColumn().nullable());
          })
          .addReference("parent", {
            type: "one",
            from: { table: "category", column: "parentId" },
            to: { table: "category", column: "id" },
          })
          .addReference("children", {
            type: "many",
            from: { table: "category", column: "id" },
            to: { table: "category", column: "parentId" },
          });
      });

      const generated = generateDrizzleSchema(
        [{ namespace: "test", schema: selfManySchema }],
        "postgresql",
      );

      // Should have both one and many relations
      expect(generated).toContain("parent: one(category_test");
      expect(generated).toContain("children: many(category_test");

      // Should only have one foreign key (from the "one" relation)
      const fkMatches = generated.match(/foreignKey\(/g);
      expect(fkMatches).toHaveLength(1);

      expect(generated).toMatchInlineSnapshot(`
        "import { pgSchema, varchar, text, bigint, bigserial, integer, foreignKey } from "drizzle-orm/pg-core"
        import { createId } from "@fragno-dev/db/id"
        import { relations } from "drizzle-orm"

        // ============================================================================
        // Fragment: test
        // ============================================================================

        const schema_test = pgSchema("test");

        export const category_test = schema_test.table("category", {
          id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
          name: text("name").notNull(),
          parentId: bigint("parentId", { mode: "number" }),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          foreignKey({
            columns: [table.parentId],
            foreignColumns: [table._internalId],
            name: "fk_category_category_parent"
          })
        ])

        export const category_testRelations = relations(category_test, ({ one, many }) => ({
          parent: one(category_test, {
            relationName: "category_category",
            fields: [category_test.parentId],
            references: [category_test._internalId]
          }),
          children: many(category_test, {
            relationName: "category_category"
          }),
          categoryList: many(category_test, {
            relationName: "category_category"
          })
        }));

        export const test_schema = {
          category_test: category_test,
          category_testRelations: category_testRelations,
          category: category_test,
          categoryRelations: category_testRelations,
          schemaVersion: 3
        }"
      `);
    });
  });

  it("should skip join-only relations in schema output", () => {
    const joinOnlySchema = schema("joinonly", (s) => {
      return s
        .addTable("users", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("email", column("string"))
            .createIndex("idx_users_email", ["email"]);
        })
        .addTable("invitations", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("email", column("string"))
            .createIndex("idx_inv_email", ["email"]);
        })
        .addReference("invitedUser", {
          type: "one",
          from: { table: "invitations", column: "email" },
          to: { table: "users", column: "email" },
          foreignKey: false,
        });
    });

    const generated = generateDrizzleSchema(
      [{ namespace: "test", schema: joinOnlySchema }],
      "postgresql",
    );

    expect(generated).not.toContain("foreignKey(");
    expect(generated).not.toContain("relations(");
  });

  describe("self-referencing foreign keys", () => {
    const selfRefSchema = schema("selfref", (s) => {
      return s
        .addTable("comment", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("content", column("string"))
            .addColumn("parentId", referenceColumn().nullable())
            .createIndex("idx_parent", ["parentId"]);
        })
        .addReference("parent", {
          type: "one",
          from: { table: "comment", column: "parentId" },
          to: { table: "comment", column: "id" },
        });
    });

    it("should generate PostgreSQL self-referencing foreign key using table parameter", () => {
      const generated = generateDrizzleSchema(
        [{ namespace: "test", schema: selfRefSchema }],
        "postgresql",
      );
      expect(generated).toMatchInlineSnapshot(`
        "import { pgSchema, varchar, text, bigint, bigserial, integer, foreignKey, index } from "drizzle-orm/pg-core"
        import { createId } from "@fragno-dev/db/id"
        import { relations } from "drizzle-orm"

        // ============================================================================
        // Fragment: test
        // ============================================================================

        const schema_test = pgSchema("test");

        export const comment_test = schema_test.table("comment", {
          id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
          content: text("content").notNull(),
          parentId: bigint("parentId", { mode: "number" }),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          foreignKey({
            columns: [table.parentId],
            foreignColumns: [table._internalId],
            name: "fk_comment_comment_parent"
          }),
          index("idx_parent").on(table.parentId)
        ])

        export const comment_testRelations = relations(comment_test, ({ one, many }) => ({
          parent: one(comment_test, {
            relationName: "comment_comment",
            fields: [comment_test.parentId],
            references: [comment_test._internalId]
          }),
          commentList: many(comment_test, {
            relationName: "comment_comment"
          })
        }));

        export const test_schema = {
          comment_test: comment_test,
          comment_testRelations: comment_testRelations,
          comment: comment_test,
          commentRelations: comment_testRelations,
          schemaVersion: 2
        }"
      `);
    });

    it("should generate MySQL self-referencing foreign key using table parameter", () => {
      const generated = generateDrizzleSchema(
        [{ namespace: "test", schema: selfRefSchema }],
        "mysql",
      );
      expect(generated).toMatchInlineSnapshot(`
        "import { mysqlTable, varchar, text, bigint, int, foreignKey, index } from "drizzle-orm/mysql-core"
        import { createId } from "@fragno-dev/db/id"
        import { relations } from "drizzle-orm"

        // ============================================================================
        // Fragment: test
        // ============================================================================

        export const comment_test = mysqlTable("comment_test", {
          id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
          content: text("content").notNull(),
          parentId: bigint("parentId", { mode: "number" }),
          _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
          _version: int("_version").notNull().default(0)
        }, (table) => [
          foreignKey({
            columns: [table.parentId],
            foreignColumns: [table._internalId],
            name: "fk_comment_comment_parent_test_af0d05a4"
          }),
          index("idx_comment_idx_parent_test_3c264dbc").on(table.parentId)
        ])

        export const comment_testRelations = relations(comment_test, ({ one, many }) => ({
          parent: one(comment_test, {
            relationName: "comment_comment",
            fields: [comment_test.parentId],
            references: [comment_test._internalId]
          }),
          commentList: many(comment_test, {
            relationName: "comment_comment"
          })
        }));

        export const test_schema = {
          comment_test: comment_test,
          comment_testRelations: comment_testRelations,
          comment: comment_test,
          commentRelations: comment_testRelations,
          schemaVersion: 2
        }"
      `);
    });

    it("should generate SQLite self-referencing foreign key using table parameter", () => {
      const generated = generateDrizzleSchema(
        [{ namespace: "test", schema: selfRefSchema }],
        "sqlite",
      );
      expect(generated).toMatchInlineSnapshot(`
        "import { sqliteTable, text, integer, foreignKey, index, uniqueIndex } from "drizzle-orm/sqlite-core"
        import { createId } from "@fragno-dev/db/id"
        import { relations } from "drizzle-orm"

        // ============================================================================
        // Fragment: test
        // ============================================================================

        export const comment_test = sqliteTable("comment_test", {
          id: text("id").notNull().unique().$defaultFn(() => createId()),
          content: text("content").notNull(),
          parentId: integer("parentId"),
          _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          foreignKey({
            columns: [table.parentId],
            foreignColumns: [table._internalId],
            name: "fk_comment_comment_parent_test_af0d05a4"
          }),
          index("idx_comment_idx_parent_test_3c264dbc").on(table.parentId),
          uniqueIndex("uidx_comment_idx_comment_external_id_test_6a1c2b8f").on(table.id)
        ])

        export const comment_testRelations = relations(comment_test, ({ one, many }) => ({
          parent: one(comment_test, {
            relationName: "comment_comment",
            fields: [comment_test.parentId],
            references: [comment_test._internalId]
          }),
          commentList: many(comment_test, {
            relationName: "comment_comment"
          })
        }));

        export const test_schema = {
          comment_test: comment_test,
          comment_testRelations: comment_testRelations,
          comment: comment_test,
          commentRelations: comment_testRelations,
          schemaVersion: 2
        }"
      `);
    });
  });

  describe("namespace sanitization", () => {
    it("should sanitize exports while preserving physical table names", () => {
      const generated = generateDrizzleSchema(
        [{ namespace: "auth-db", schema: testSchema }],
        "postgresql",
      );

      // TypeScript exports must use sanitized names (underscores)
      expect(generated).toContain("export const users_auth_db =");
      expect(generated).toContain("export const posts_auth_db =");

      // Physical table names use logical names with schema scoping
      expect(generated).toContain('const schema_auth_db = pgSchema("auth-db");');
      expect(generated).toContain('schema_auth_db.table("users"');
      expect(generated).toContain('schema_auth_db.table("posts"');

      // Foreign key name should use the original namespace with hashed naming
      expect(generated).toMatch(/name: "fk_posts_users_author"/);

      // Relations should reference sanitized table names
      expect(generated).toContain("foreignColumns: [users_auth_db._internalId]");
      expect(generated).toContain("fields: [posts_auth_db.userId]");
      expect(generated).toContain("references: [users_auth_db._internalId]");

      // Schema export should use sanitized keys
      expect(generated).toContain("export const auth_db_schema = {");
      expect(generated).toContain("users_auth_db: users_auth_db");
      expect(generated).toContain("users: users_auth_db");
      expect(generated).toContain("posts_auth_db: posts_auth_db");
      expect(generated).toContain("posts: posts_auth_db");

      // Inverse relations should be generated for relational queries
      expect(generated).toContain("users_auth_dbRelations");
      expect(generated).toContain("postsList: many(posts_auth_db");
    });

    it("should generate inverse relations for namespaced tables", () => {
      const generated = generateDrizzleSchema(
        [{ namespace: "my-app", schema: testSchema }],
        "postgresql",
      );

      // User should have inverse "many" relation to posts
      expect(generated).toMatch(
        /export const users_my_appRelations = relations\(users_my_app, \(\{ many \}\) => \(\{/,
      );
      expect(generated).toContain("postsList: many(posts_my_app");

      // Both relations should be included in schema export
      expect(generated).toContain("users_my_appRelations: users_my_appRelations");
      expect(generated).toContain("posts_my_appRelations: posts_my_appRelations");
    });

    it("should sanitize exports with special characters in foreign key references", () => {
      const generated = generateDrizzleSchema(
        [{ namespace: "my-fragment-v2", schema: testSchema }],
        "postgresql",
      );

      // Should generate valid JavaScript identifiers (underscores instead of hyphens)
      expect(generated).toContain("export const users_my_fragment_v2 =");
      expect(generated).toContain("export const posts_my_fragment_v2 =");

      // Foreign key should reference sanitized table name
      expect(generated).toContain("foreignColumns: [users_my_fragment_v2._internalId]");

      // Relations should also use sanitized names
      expect(generated).toContain("author: one(users_my_fragment_v2");
      expect(generated).toContain("fields: [posts_my_fragment_v2.userId]");
      expect(generated).toContain("references: [users_my_fragment_v2._internalId]");

      // Physical table names use logical names with schema scoping
      expect(generated).toContain('const schema_my_fragment_v2 = pgSchema("my-fragment-v2");');
      expect(generated).toContain('schema_my_fragment_v2.table("users"');
      expect(generated).toContain('schema_my_fragment_v2.table("posts"');

      expect(generated).toMatchInlineSnapshot(`
        "import { pgSchema, varchar, text, integer, bigserial, uniqueIndex, index, bigint, foreignKey } from "drizzle-orm/pg-core"
        import { createId } from "@fragno-dev/db/id"
        import { relations } from "drizzle-orm"

        // ============================================================================
        // Fragment: my-fragment-v2
        // ============================================================================

        const schema_my_fragment_v2 = pgSchema("my-fragment-v2");

        export const users_my_fragment_v2 = schema_my_fragment_v2.table("users", {
          id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
          name: text("name").notNull(),
          email: text("email").notNull(),
          age: integer("age"),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          uniqueIndex("idx_email").on(table.email),
          index("idx_name").on(table.name)
        ])

        export const posts_my_fragment_v2 = schema_my_fragment_v2.table("posts", {
          id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
          title: text("title").notNull(),
          content: text("content").notNull(),
          userId: bigint("userId", { mode: "number" }).notNull(),
          viewCount: integer("viewCount").notNull().default(0),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          foreignKey({
            columns: [table.userId],
            foreignColumns: [users_my_fragment_v2._internalId],
            name: "fk_posts_users_author"
          }),
          index("idx_user").on(table.userId),
          index("idx_title").on(table.title)
        ])

        export const users_my_fragment_v2Relations = relations(users_my_fragment_v2, ({ many }) => ({
          postsList: many(posts_my_fragment_v2, {
            relationName: "posts_users"
          })
        }));

        export const posts_my_fragment_v2Relations = relations(posts_my_fragment_v2, ({ one }) => ({
          author: one(users_my_fragment_v2, {
            relationName: "posts_users",
            fields: [posts_my_fragment_v2.userId],
            references: [users_my_fragment_v2._internalId]
          })
        }));

        export const my_fragment_v2_schema = {
          users_my_fragment_v2: users_my_fragment_v2,
          users_my_fragment_v2Relations: users_my_fragment_v2Relations,
          users: users_my_fragment_v2,
          usersRelations: users_my_fragment_v2Relations,
          posts_my_fragment_v2: posts_my_fragment_v2,
          posts_my_fragment_v2Relations: posts_my_fragment_v2Relations,
          posts: posts_my_fragment_v2,
          postsRelations: posts_my_fragment_v2Relations,
          schemaVersion: 3
        }"
      `);
    });
  });

  describe("schema generation", () => {
    it("should generate settings schema and multiple user fragments", () => {
      // settingsSchema is imported at the top to simulate what happens with linked internal fragments
      const fragment1Schema = schema("fragment1", (s) => {
        return s.addTable("users", (t) => {
          return t.addColumn("id", idColumn()).addColumn("name", column("string"));
        });
      });

      const fragment2Schema = schema("fragment2", (s) => {
        return s.addTable("posts", (t) => {
          return t.addColumn("id", idColumn()).addColumn("title", column("string"));
        });
      });

      // De-duplication happens in generation-engine.ts before calling generateDrizzleSchema
      // This test verifies generateDrizzleSchema works correctly with already-deduplicated inputs
      const generated = generateDrizzleSchema(
        [
          { namespace: null, schema: internalSchema }, // Internal fragment (namespace: null)
          { namespace: "fragment1", schema: fragment1Schema },
          { namespace: "fragment2", schema: fragment2Schema },
        ],
        "postgresql",
      );

      // Count how many times fragno_db_settings appears in the output
      const settingsTableMatches = generated.match(/export const fragno_db_settings = /g);
      expect(settingsTableMatches).toHaveLength(1);

      // Verify it appears before the fragment tables
      const lines = generated.split("\n");
      const settingsIndex = lines.findIndex((line) =>
        line.includes("export const fragno_db_settings"),
      );
      const usersIndex = lines.findIndex((line) => line.includes("export const users_fragment1"));
      const postsIndex = lines.findIndex((line) => line.includes("export const posts_fragment2"));

      expect(settingsIndex).toBeLessThan(usersIndex);
      expect(settingsIndex).toBeLessThan(postsIndex);

      // Verify the structure includes all expected tables
      expect(generated).toContain("export const fragno_db_settings");
      expect(generated).toContain("export const users_fragment1");
      expect(generated).toContain("export const posts_fragment2");
      expect(generated).toContain("export const fragment1_schema");
      expect(generated).toContain("export const fragment2_schema");
    });

    it("should generate schema for single fragment with custom namespace", () => {
      // Test a simple single-schema generation
      const sharedSchema = schema("shared", (s) => {
        return s.addTable("shared_table", (t) => {
          return t.addColumn("id", idColumn()).addColumn("data", column("string"));
        });
      });

      // De-duplication happens in generation-engine.ts, so we pass pre-deduplicated input
      const generated = generateDrizzleSchema(
        [{ namespace: "namespace1", schema: sharedSchema }],
        "postgresql",
      );

      // Should generate the schema with the provided namespace
      const sharedTableMatches = generated.match(/export const shared_table_/g);
      expect(sharedTableMatches).toHaveLength(1);

      expect(generated).toContain("export const shared_table_namespace1");
      expect(generated).toContain("export const namespace1_schema");
    });
  });
});
