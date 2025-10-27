import { describe, expect, it, afterEach } from "vitest";
import { column, idColumn, schema } from "@fragno-dev/db/schema";
import { defineFragmentWithDatabase } from "@fragno-dev/db/fragment";
import { createDatabaseFragmentForTest } from "./index";
import { unlinkSync, existsSync } from "node:fs";

// Test schema with multiple versions
const testSchema = schema((s) => {
  return s
    .addTable("users", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("email", column("string"))
        .createIndex("idx_users_all", ["id"]); // Index for querying
    })
    .alterTable("users", (t) => {
      return t.addColumn("age", column("integer").nullable());
    });
});

// Test fragment definition
const testFragmentDef = defineFragmentWithDatabase<{}>("test-fragment")
  .withDatabase(testSchema)
  .withServices(({ orm }) => {
    return {
      createUser: async (data: { name: string; email: string; age?: number | null }) => {
        const id = await orm.create("users", data);
        return { ...data, id: id.valueOf() };
      },
      getUsers: async () => {
        const users = await orm.find("users", (b) =>
          b.whereIndex("idx_users_all", (eb) => eb("id", "!=", "")),
        );
        return users.map((u) => ({ ...u, id: u.id.valueOf() }));
      },
    };
  });

describe("createDatabaseFragmentForTest", () => {
  describe("databasePath option", () => {
    const testDbPath = "./test-fragno.pglite";

    afterEach(() => {
      // Clean up test database files
      if (existsSync(testDbPath)) {
        try {
          unlinkSync(testDbPath);
        } catch {
          // Ignore cleanup errors
        }
      }
    });

    it("should use in-memory database by default", async () => {
      const fragment = await createDatabaseFragmentForTest(testFragmentDef);

      // Should be able to create and query users
      const user = await fragment.services.createUser({
        name: "Test User",
        email: "test@example.com",
        age: 25,
      });

      expect(user).toMatchObject({
        id: expect.any(String),
        name: "Test User",
        email: "test@example.com",
        age: 25,
      });

      const users = await fragment.services.getUsers();
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject(user);
    });

    it("should create database at specified path", async () => {
      const fragment = await createDatabaseFragmentForTest(testFragmentDef, {
        databasePath: testDbPath,
      });

      // Create a user
      await fragment.services.createUser({
        name: "Persisted User",
        email: "persisted@example.com",
        age: 30,
      });

      // Verify data exists in this instance
      const users = await fragment.services.getUsers();
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({
        name: "Persisted User",
        email: "persisted@example.com",
        age: 30,
      });
    });
  });

  describe("migrateToVersion option", () => {
    it("should migrate to latest version by default", async () => {
      const fragment = await createDatabaseFragmentForTest(testFragmentDef);

      // Should have the 'age' column from version 2
      const user = await fragment.services.createUser({
        name: "Test User",
        email: "test@example.com",
        age: 25,
      });

      expect(user).toMatchObject({
        id: expect.any(String),
        name: "Test User",
        email: "test@example.com",
        age: 25,
      });
    });

    it("should migrate to specific version when specified", async () => {
      // Migrate to version 1 (before 'age' column was added)
      const fragment = await createDatabaseFragmentForTest(testFragmentDef, {
        migrateToVersion: 1,
      });

      // Query the database directly to check schema
      // In version 1, we should be able to insert without the age column
      const tableName = "users_test-fragment-db";
      await fragment.kysely
        .insertInto(tableName)
        .values({
          id: "test-id-1",
          name: "V1 User",
          email: "v1@example.com",
        })
        .execute();

      const result = await fragment.kysely.selectFrom(tableName).selectAll().execute();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: "test-id-1",
        name: "V1 User",
        email: "v1@example.com",
      });
      // In version 1, the age column should not exist
      expect(result[0]).not.toHaveProperty("age");
    });

    it("should allow creating user with age when migrated to version 2", async () => {
      // Explicitly migrate to version 2
      const fragment = await createDatabaseFragmentForTest(testFragmentDef, {
        migrateToVersion: 2,
      });

      // Should be able to use age column
      const user = await fragment.services.createUser({
        name: "V2 User",
        email: "v2@example.com",
        age: 35,
      });

      expect(user).toMatchObject({
        id: expect.any(String),
        name: "V2 User",
        email: "v2@example.com",
        age: 35,
      });

      const tableName = "users_test-fragment-db";
      const result = await fragment.kysely.selectFrom(tableName).selectAll().execute();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: "V2 User",
        email: "v2@example.com",
        age: 35,
      });
    });
  });

  describe("combined options", () => {
    const testDbPath = "./test-combined.pglite";

    afterEach(() => {
      if (existsSync(testDbPath)) {
        try {
          unlinkSync(testDbPath);
        } catch {
          // Ignore cleanup errors
        }
      }
    });

    it("should work with both databasePath and migrateToVersion", async () => {
      const fragment = await createDatabaseFragmentForTest(testFragmentDef, {
        databasePath: testDbPath,
        migrateToVersion: 2,
      });

      // Create user at version 2 (with age support)
      const user = await fragment.services.createUser({
        name: "Combined Test",
        email: "combined@example.com",
        age: 40,
      });

      expect(user).toMatchObject({
        id: expect.any(String),
        name: "Combined Test",
        email: "combined@example.com",
        age: 40,
      });

      const users = await fragment.services.getUsers();
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({
        name: "Combined Test",
        email: "combined@example.com",
        age: 40,
      });
    });
  });

  describe("fragment initialization", () => {
    it("should provide kysely instance", async () => {
      const fragment = await createDatabaseFragmentForTest(testFragmentDef);

      expect(fragment.kysely).toBeDefined();
      expect(typeof fragment.kysely.selectFrom).toBe("function");
    });

    it("should provide adapter instance", async () => {
      const fragment = await createDatabaseFragmentForTest(testFragmentDef);

      expect(fragment.adapter).toBeDefined();
      expect(typeof fragment.adapter.createMigrationEngine).toBe("function");
    });

    it("should have all standard fragment test properties", async () => {
      const fragment = await createDatabaseFragmentForTest(testFragmentDef);

      expect(fragment.services).toBeDefined();
      expect(fragment.initRoutes).toBeDefined();
      expect(fragment.handler).toBeDefined();
    });

    it("should throw error for non-database fragment", async () => {
      // Create a fragment without database
      const nonDbFragment = {
        definition: {
          name: "non-db-fragment",
          additionalContext: {},
        },
        $requiredOptions: {},
      };

      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createDatabaseFragmentForTest(nonDbFragment as any),
      ).rejects.toThrow("Fragment 'non-db-fragment' does not have a database schema");
    });
  });
});
