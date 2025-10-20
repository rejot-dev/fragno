import { describe, expect, it } from "vitest";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import { generateSchema } from "./generate";

describe("generateSchema", () => {
  const testSchema = schema((s) => {
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

  describe("postgresql", () => {
    it("should generate PostgreSQL schema", () => {
      const generated = generateSchema(testSchema, "postgresql");
      expect(generated).toMatchInlineSnapshot(`
        "import { pgTable, varchar, text, integer, bigserial, uniqueIndex, index, bigint, foreignKey } from "drizzle-orm/pg-core"
        import { createId } from "@fragno-dev/db/id"
        import { relations } from "drizzle-orm"

        export const users = pgTable("users", {
          id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
          name: text("name").notNull(),
          email: text("email").notNull(),
          age: integer("age"),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          uniqueIndex("idx_email").on(table.email),
          index("idx_name").on(table.name)
        ])

        export const posts = pgTable("posts", {
          id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
          title: text("title").notNull(),
          content: text("content").notNull(),
          userId: bigint("userId", { mode: "number" }).notNull(),
          viewCount: integer("viewCount").notNull().default(0),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          foreignKey({
            columns: [table.userId],
            foreignColumns: [users._internalId],
            name: "posts_users_author_fk"
          }),
          index("idx_user").on(table.userId),
          index("idx_title").on(table.title)
        ])

        export const postsRelations = relations(posts, ({ one }) => ({
          author: one(users, {
            relationName: "posts_users",
            fields: [posts.userId],
            references: [users._internalId]
          })
        }));"
      `);
    });
  });

  describe("mysql", () => {
    it("should generate MySQL schema", () => {
      const generated = generateSchema(testSchema, "mysql");
      expect(generated).toMatchInlineSnapshot(`
        "import { mysqlTable, varchar, text, integer, bigint, uniqueIndex, index, foreignKey } from "drizzle-orm/mysql-core"
        import { createId } from "@fragno-dev/db/id"
        import { relations } from "drizzle-orm"

        export const users = mysqlTable("users", {
          id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
          name: text("name").notNull(),
          email: text("email").notNull(),
          age: integer("age"),
          _internalId: bigint("_internalId").primaryKey().autoincrement().notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          uniqueIndex("idx_email").on(table.email),
          index("idx_name").on(table.name)
        ])

        export const posts = mysqlTable("posts", {
          id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
          title: text("title").notNull(),
          content: text("content").notNull(),
          userId: bigint("userId").notNull(),
          viewCount: integer("viewCount").notNull().default(0),
          _internalId: bigint("_internalId").primaryKey().autoincrement().notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          foreignKey({
            columns: [table.userId],
            foreignColumns: [users._internalId],
            name: "posts_users_author_fk"
          }),
          index("idx_user").on(table.userId),
          index("idx_title").on(table.title)
        ])

        export const postsRelations = relations(posts, ({ one }) => ({
          author: one(users, {
            relationName: "posts_users",
            fields: [posts.userId],
            references: [users._internalId]
          })
        }));"
      `);
    });
  });

  describe("sqlite", () => {
    it("should generate SQLite schema", () => {
      const generated = generateSchema(testSchema, "sqlite");
      expect(generated).toMatchInlineSnapshot(`
        "import { sqliteTable, text, integer, uniqueIndex, index, blob, foreignKey } from "drizzle-orm/sqlite-core"
        import { createId } from "@fragno-dev/db/id"
        import { relations } from "drizzle-orm"

        export const users = sqliteTable("users", {
          id: text("id").notNull().$defaultFn(() => createId()),
          name: text("name").notNull(),
          email: text("email").notNull(),
          age: integer("age"),
          _internalId: integer("_internalId").primaryKey().autoincrement().notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          uniqueIndex("idx_email").on(table.email),
          index("idx_name").on(table.name)
        ])

        export const posts = sqliteTable("posts", {
          id: text("id").notNull().$defaultFn(() => createId()),
          title: text("title").notNull(),
          content: text("content").notNull(),
          userId: blob("userId", { mode: "bigint" }).notNull(),
          viewCount: integer("viewCount").notNull().default(0),
          _internalId: integer("_internalId").primaryKey().autoincrement().notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          foreignKey({
            columns: [table.userId],
            foreignColumns: [users._internalId],
            name: "posts_users_author_fk"
          }),
          index("idx_user").on(table.userId),
          index("idx_title").on(table.title)
        ])

        export const postsRelations = relations(posts, ({ one }) => ({
          author: one(users, {
            relationName: "posts_users",
            fields: [posts.userId],
            references: [users._internalId]
          })
        }));"
      `);
    });
  });

  describe("default values", () => {
    it("should handle runtime default values", () => {
      const timestampSchema = schema((s) => {
        return s.addTable("events", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("createdAt", column("timestamp").defaultTo$("now"));
        });
      });

      const generated = generateSchema(timestampSchema, "postgresql");
      expect(generated).toMatchInlineSnapshot(`
        "import { pgTable, varchar, timestamp, bigserial, integer } from "drizzle-orm/pg-core"
        import { createId } from "@fragno-dev/db/id"

        export const events = pgTable("events", {
          id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
          createdAt: timestamp("createdAt").notNull().defaultNow(),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        })"
      `);
    });
  });

  describe("binary columns", () => {
    it("should generate custom type for binary columns", () => {
      const binarySchema = schema((s) => {
        return s.addTable("files", (t) => {
          return t.addColumn("id", idColumn()).addColumn("data", column("binary"));
        });
      });

      const generated = generateSchema(binarySchema, "postgresql");
      expect(generated).toMatchInlineSnapshot(`
        "import { pgTable, varchar, customType, bigserial, integer } from "drizzle-orm/pg-core"
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

        export const files = pgTable("files", {
          id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
          data: customBinary("data").notNull(),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        })"
      `);
    });
  });

  describe("many relations", () => {
    const oneToManySchema = schema((s) => {
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
      const generated = generateSchema(oneToManySchema, "postgresql");
      expect(generated).toMatchInlineSnapshot(`
        "import { pgTable, varchar, text, bigserial, integer, bigint, foreignKey, index } from "drizzle-orm/pg-core"
        import { createId } from "@fragno-dev/db/id"
        import { relations } from "drizzle-orm"

        export const users = pgTable("users", {
          id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
          name: text("name").notNull(),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        })

        export const usersRelations = relations(users, ({ many }) => ({
          posts: many(posts, {
            relationName: "users_posts"
          })
        }));

        export const posts = pgTable("posts", {
          id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
          title: text("title").notNull(),
          userId: bigint("userId", { mode: "number" }).notNull(),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          foreignKey({
            columns: [table.userId],
            foreignColumns: [users._internalId],
            name: "posts_users_author_fk"
          }),
          index("idx_user").on(table.userId)
        ])

        export const postsRelations = relations(posts, ({ one }) => ({
          author: one(users, {
            relationName: "posts_users",
            fields: [posts.userId],
            references: [users._internalId]
          })
        }));"
      `);
    });

    it("should generate MySQL schema with many relations", () => {
      const generated = generateSchema(oneToManySchema, "mysql");
      expect(generated).toMatchInlineSnapshot(`
        "import { mysqlTable, varchar, text, bigint, integer, foreignKey, index } from "drizzle-orm/mysql-core"
        import { createId } from "@fragno-dev/db/id"
        import { relations } from "drizzle-orm"

        export const users = mysqlTable("users", {
          id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
          name: text("name").notNull(),
          _internalId: bigint("_internalId").primaryKey().autoincrement().notNull(),
          _version: integer("_version").notNull().default(0)
        })

        export const usersRelations = relations(users, ({ many }) => ({
          posts: many(posts, {
            relationName: "users_posts"
          })
        }));

        export const posts = mysqlTable("posts", {
          id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
          title: text("title").notNull(),
          userId: bigint("userId").notNull(),
          _internalId: bigint("_internalId").primaryKey().autoincrement().notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          foreignKey({
            columns: [table.userId],
            foreignColumns: [users._internalId],
            name: "posts_users_author_fk"
          }),
          index("idx_user").on(table.userId)
        ])

        export const postsRelations = relations(posts, ({ one }) => ({
          author: one(users, {
            relationName: "posts_users",
            fields: [posts.userId],
            references: [users._internalId]
          })
        }));"
      `);
    });

    it("should generate SQLite schema with many relations", () => {
      const generated = generateSchema(oneToManySchema, "sqlite");
      expect(generated).toMatchInlineSnapshot(`
        "import { sqliteTable, text, integer, blob, foreignKey, index } from "drizzle-orm/sqlite-core"
        import { createId } from "@fragno-dev/db/id"
        import { relations } from "drizzle-orm"

        export const users = sqliteTable("users", {
          id: text("id").notNull().$defaultFn(() => createId()),
          name: text("name").notNull(),
          _internalId: integer("_internalId").primaryKey().autoincrement().notNull(),
          _version: integer("_version").notNull().default(0)
        })

        export const usersRelations = relations(users, ({ many }) => ({
          posts: many(posts, {
            relationName: "users_posts"
          })
        }));

        export const posts = sqliteTable("posts", {
          id: text("id").notNull().$defaultFn(() => createId()),
          title: text("title").notNull(),
          userId: blob("userId", { mode: "bigint" }).notNull(),
          _internalId: integer("_internalId").primaryKey().autoincrement().notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          foreignKey({
            columns: [table.userId],
            foreignColumns: [users._internalId],
            name: "posts_users_author_fk"
          }),
          index("idx_user").on(table.userId)
        ])

        export const postsRelations = relations(posts, ({ one }) => ({
          author: one(users, {
            relationName: "posts_users",
            fields: [posts.userId],
            references: [users._internalId]
          })
        }));"
      `);
    });

    it("should handle table with only many relations (no foreign keys)", () => {
      const manyOnlySchema = schema((s) => {
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

      const generated = generateSchema(manyOnlySchema, "postgresql");

      // Categories table should NOT have a constraint callback (no foreign keys, no indexes)
      const categoriesTableMatch = generated.match(
        /export const categories = pgTable\("categories", \{[^}]+\}\)/,
      );
      expect(categoriesTableMatch).toBeTruthy();

      // Should have relations with many
      expect(generated).toContain(
        "export const categoriesRelations = relations(categories, ({ many }) => ({",
      );
      expect(generated).toContain("products: many(products");
      expect(generated).toMatchInlineSnapshot(`
        "import { pgTable, varchar, text, bigserial, integer, bigint } from "drizzle-orm/pg-core"
        import { createId } from "@fragno-dev/db/id"
        import { relations } from "drizzle-orm"

        export const categories = pgTable("categories", {
          id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
          name: text("name").notNull(),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        })

        export const categoriesRelations = relations(categories, ({ many }) => ({
          products: many(products, {
            relationName: "categories_products"
          })
        }));

        export const products = pgTable("products", {
          id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
          name: text("name").notNull(),
          categoryId: bigint("categoryId", { mode: "number" }).notNull(),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        })"
      `);
    });

    it("should handle self-referencing many relations", () => {
      const selfManySchema = schema((s) => {
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

      const generated = generateSchema(selfManySchema, "postgresql");

      // Should have both one and many relations
      expect(generated).toContain("parent: one(category");
      expect(generated).toContain("children: many(category");

      // Should only have one foreign key (from the "one" relation)
      const fkMatches = generated.match(/foreignKey\(/g);
      expect(fkMatches).toHaveLength(1);

      expect(generated).toMatchInlineSnapshot(`
        "import { pgTable, varchar, text, bigint, bigserial, integer, foreignKey } from "drizzle-orm/pg-core"
        import { createId } from "@fragno-dev/db/id"
        import { relations } from "drizzle-orm"

        export const category = pgTable("category", {
          id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
          name: text("name").notNull(),
          parentId: bigint("parentId", { mode: "number" }),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          foreignKey({
            columns: [table.parentId],
            foreignColumns: [table._internalId],
            name: "category_category_parent_fk"
          })
        ])

        export const categoryRelations = relations(category, ({ one, many }) => ({
          parent: one(category, {
            relationName: "category_category",
            fields: [category.parentId],
            references: [category._internalId]
          }),
          children: many(category, {
            relationName: "category_category"
          })
        }));"
      `);
    });
  });

  describe("self-referencing foreign keys", () => {
    const selfRefSchema = schema((s) => {
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
      const generated = generateSchema(selfRefSchema, "postgresql");
      expect(generated).toMatchInlineSnapshot(`
        "import { pgTable, varchar, text, bigint, bigserial, integer, foreignKey, index } from "drizzle-orm/pg-core"
        import { createId } from "@fragno-dev/db/id"
        import { relations } from "drizzle-orm"

        export const comment = pgTable("comment", {
          id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
          content: text("content").notNull(),
          parentId: bigint("parentId", { mode: "number" }),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          foreignKey({
            columns: [table.parentId],
            foreignColumns: [table._internalId],
            name: "comment_comment_parent_fk"
          }),
          index("idx_parent").on(table.parentId)
        ])

        export const commentRelations = relations(comment, ({ one }) => ({
          parent: one(comment, {
            relationName: "comment_comment",
            fields: [comment.parentId],
            references: [comment._internalId]
          })
        }));"
      `);
    });

    it("should generate MySQL self-referencing foreign key using table parameter", () => {
      const generated = generateSchema(selfRefSchema, "mysql");
      expect(generated).toMatchInlineSnapshot(`
        "import { mysqlTable, varchar, text, bigint, integer, foreignKey, index } from "drizzle-orm/mysql-core"
        import { createId } from "@fragno-dev/db/id"
        import { relations } from "drizzle-orm"

        export const comment = mysqlTable("comment", {
          id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
          content: text("content").notNull(),
          parentId: bigint("parentId"),
          _internalId: bigint("_internalId").primaryKey().autoincrement().notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          foreignKey({
            columns: [table.parentId],
            foreignColumns: [table._internalId],
            name: "comment_comment_parent_fk"
          }),
          index("idx_parent").on(table.parentId)
        ])

        export const commentRelations = relations(comment, ({ one }) => ({
          parent: one(comment, {
            relationName: "comment_comment",
            fields: [comment.parentId],
            references: [comment._internalId]
          })
        }));"
      `);
    });

    it("should generate SQLite self-referencing foreign key using table parameter", () => {
      const generated = generateSchema(selfRefSchema, "sqlite");
      expect(generated).toMatchInlineSnapshot(`
        "import { sqliteTable, text, blob, integer, foreignKey, index } from "drizzle-orm/sqlite-core"
        import { createId } from "@fragno-dev/db/id"
        import { relations } from "drizzle-orm"

        export const comment = sqliteTable("comment", {
          id: text("id").notNull().$defaultFn(() => createId()),
          content: text("content").notNull(),
          parentId: blob("parentId", { mode: "bigint" }),
          _internalId: integer("_internalId").primaryKey().autoincrement().notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          foreignKey({
            columns: [table.parentId],
            foreignColumns: [table._internalId],
            name: "comment_comment_parent_fk"
          }),
          index("idx_parent").on(table.parentId)
        ])

        export const commentRelations = relations(comment, ({ one }) => ({
          parent: one(comment, {
            relationName: "comment_comment",
            fields: [comment.parentId],
            references: [comment._internalId]
          })
        }));"
      `);
    });
  });
});
