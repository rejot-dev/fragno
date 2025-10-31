import { describe, expect, it, afterEach } from "vitest";
import { column, idColumn, schema } from "@fragno-dev/db/schema";
import { defineFragmentWithDatabase } from "@fragno-dev/db/fragment";
import { createDatabaseFragmentForTest } from "./index";
import { unlinkSync, existsSync } from "node:fs";
import { defineRoute, defineRoutes } from "@fragno-dev/core";
import { z } from "zod";

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
      const { fragment } = await createDatabaseFragmentForTest(testFragmentDef, [], {
        adapter: { type: "kysely-sqlite" },
      });

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
      const { fragment } = await createDatabaseFragmentForTest(testFragmentDef, [], {
        adapter: { type: "kysely-sqlite", databasePath: testDbPath },
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
      const { fragment } = await createDatabaseFragmentForTest(testFragmentDef, [], {
        adapter: { type: "kysely-sqlite" },
      });

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
      const { test } = await createDatabaseFragmentForTest(testFragmentDef, [], {
        adapter: { type: "kysely-sqlite" },
        migrateToVersion: 1,
      });

      // Query the database directly to check schema
      // In version 1, we should be able to insert without the age column
      const tableName = "users_test-fragment-db";
      await test.kysely
        .insertInto(tableName)
        .values({
          id: "test-id-1",
          name: "V1 User",
          email: "v1@example.com",
        })
        .execute();

      const result = await test.kysely.selectFrom(tableName).selectAll().execute();

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
      const { fragment, test } = await createDatabaseFragmentForTest(testFragmentDef, [], {
        adapter: { type: "kysely-sqlite" },
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
      const result = await test.kysely.selectFrom(tableName).selectAll().execute();

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
      const { fragment } = await createDatabaseFragmentForTest(testFragmentDef, [], {
        adapter: { type: "kysely-sqlite", databasePath: testDbPath },
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
      const { test } = await createDatabaseFragmentForTest(testFragmentDef, [], {
        adapter: { type: "kysely-sqlite" },
      });

      expect(test.kysely).toBeDefined();
      expect(typeof test.kysely.selectFrom).toBe("function");
    });

    it("should provide adapter instance", async () => {
      const { test } = await createDatabaseFragmentForTest(testFragmentDef, [], {
        adapter: { type: "kysely-sqlite" },
      });

      expect(test.adapter).toBeDefined();
      expect(typeof test.adapter.createMigrationEngine).toBe("function");
    });

    it("should have all standard fragment test properties", async () => {
      const { fragment } = await createDatabaseFragmentForTest(testFragmentDef, [], {
        adapter: { type: "kysely-sqlite" },
      });

      expect(fragment.services).toBeDefined();
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
        createDatabaseFragmentForTest(nonDbFragment as any, [], {
          adapter: { type: "kysely-sqlite" },
        }),
      ).rejects.toThrow("Fragment 'non-db-fragment' does not have a database schema");
    });
  });

  describe("route handling with defineRoutes", () => {
    it("should handle route factory with multiple routes", async () => {
      type Config = {};
      type Deps = {};
      type Services = {
        createUser: (data: { name: string; email: string; age?: number | null }) => Promise<{
          name: string;
          email: string;
          age?: number | null;
          id: string;
        }>;
        getUsers: () => Promise<{ name: string; email: string; age: number | null; id: string }[]>;
      };

      const routeFactory = defineRoutes<Config, Deps, Services>().create(({ services }) => [
        defineRoute({
          method: "POST",
          path: "/users",
          inputSchema: z.object({
            name: z.string(),
            email: z.string(),
            age: z.number().nullable().optional(),
          }),
          outputSchema: z.object({
            id: z.string(),
            name: z.string(),
            email: z.string(),
            age: z.number().nullable().optional(),
          }),
          handler: async ({ input }, { json }) => {
            if (input) {
              const data = await input.valid();
              const user = await services.createUser(data);
              return json(user);
            }
            return json({ id: "", name: "", email: "", age: null });
          },
        }),
        defineRoute({
          method: "GET",
          path: "/users",
          outputSchema: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              email: z.string(),
              age: z.number().nullable(),
            }),
          ),
          handler: async (_ctx, { json }) => {
            const users = await services.getUsers();
            return json(users);
          },
        }),
      ]);

      const routes = [routeFactory] as const;
      const { fragment } = await createDatabaseFragmentForTest(testFragmentDef, routes, {
        adapter: { type: "kysely-sqlite" },
      });
      // Test creating a user
      const createResponse = await fragment.callRoute("POST", "/users", {
        body: { name: "John Doe", email: "john@example.com", age: 30 },
      });

      expect(createResponse.type).toBe("json");
      if (createResponse.type === "json") {
        expect(createResponse.data).toMatchObject({
          id: expect.any(String),
          name: "John Doe",
          email: "john@example.com",
          age: 30,
        });
      }

      // Test getting users
      const getUsersResponse = await fragment.callRoute("GET", "/users");

      expect(getUsersResponse.type).toBe("json");
      if (getUsersResponse.type === "json") {
        expect(getUsersResponse.data).toHaveLength(1);
        expect(getUsersResponse.data[0]).toMatchObject({
          id: expect.any(String),
          name: "John Doe",
          email: "john@example.com",
          age: 30,
        });
      }
    });
  });

  describe("resetDatabase", () => {
    const adapters = [
      { name: "Kysely SQLite", adapter: { type: "kysely-sqlite" as const } },
      { name: "Kysely PGLite", adapter: { type: "kysely-pglite" as const } },
      { name: "Drizzle PGLite", adapter: { type: "drizzle-pglite" as const } },
    ];

    for (const { name, adapter } of adapters) {
      describe(name, () => {
        it("should clear all data and recreate a fresh database", async () => {
          // Don't destructure so we can access the updated fragment through getters after reset
          const result = await createDatabaseFragmentForTest(testFragmentDef, [], {
            adapter,
          });

          // Create some users
          await result.services.createUser({
            name: "User 1",
            email: "user1@example.com",
            age: 25,
          });
          await result.services.createUser({
            name: "User 2",
            email: "user2@example.com",
            age: 30,
          });

          // Verify users exist
          let users = await result.services.getUsers();
          expect(users).toHaveLength(2);

          // Reset the database
          await result.test.resetDatabase();

          // Verify database is empty (accessing through result to get updated fragment)
          users = await result.services.getUsers();
          expect(users).toHaveLength(0);

          // Verify we can still create new users after reset
          const newUser = await result.services.createUser({
            name: "User After Reset",
            email: "after@example.com",
            age: 35,
          });

          expect(newUser).toMatchObject({
            id: expect.any(String),
            name: "User After Reset",
            email: "after@example.com",
            age: 35,
          });

          users = await result.services.getUsers();
          expect(users).toHaveLength(1);
          expect(users[0]).toMatchObject(newUser);

          // Cleanup
          await result.test.cleanup();
        }, 10000);
      });
    }
  });

  describe("db property access", () => {
    const adapters = [
      { name: "Kysely SQLite", adapter: { type: "kysely-sqlite" as const } },
      { name: "Kysely PGLite", adapter: { type: "kysely-pglite" as const } },
      { name: "Drizzle PGLite", adapter: { type: "drizzle-pglite" as const } },
    ];

    for (const { name, adapter } of adapters) {
      describe(name, () => {
        it("should expose db property for direct ORM queries", async () => {
          const { test } = await createDatabaseFragmentForTest(testFragmentDef, [], {
            adapter,
          });

          // Test creating a record directly using test.db
          const userId = await test.db.create("users", {
            name: "Direct DB User",
            email: "direct@example.com",
            age: 28,
          });

          expect(userId).toBeDefined();
          expect(typeof userId.valueOf()).toBe("string");

          // Test finding records using test.db
          const users = await test.db.find("users", (b) =>
            b.whereIndex("idx_users_all", (eb) => eb("id", "=", userId)),
          );

          expect(users).toHaveLength(1);
          expect(users[0]).toMatchObject({
            id: userId,
            name: "Direct DB User",
            email: "direct@example.com",
            age: 28,
          });

          // Test findFirst using test.db
          const user = await test.db.findFirst("users", (b) =>
            b.whereIndex("idx_users_all", (eb) => eb("id", "=", userId)),
          );

          expect(user).toMatchObject({
            id: userId,
            name: "Direct DB User",
            email: "direct@example.com",
            age: 28,
          });

          // Cleanup
          await test.cleanup();
        }, 10000);

        it("should maintain db property after resetDatabase", async () => {
          const result = await createDatabaseFragmentForTest(testFragmentDef, [], {
            adapter,
          });

          // Create initial data using test.db
          await result.test.db.create("users", {
            name: "Before Reset",
            email: "before@example.com",
            age: 25,
          });

          // Verify db works before reset
          expect(result.test.db).toBeDefined();
          expect(typeof result.test.db.create).toBe("function");

          // Verify data exists
          let users = await result.test.db.find("users");
          expect(users).toHaveLength(1);

          // Reset database
          await result.test.resetDatabase();

          // Verify database was actually reset (no data)
          users = await result.test.db.find("users");
          expect(users).toHaveLength(0);

          // Verify we can still use the ORM after reset
          const newUserId = await result.test.db.create("users", {
            name: "After Reset",
            email: "after@example.com",
            age: 30,
          });

          expect(newUserId).toBeDefined();

          const newUsers = await result.test.db.find("users");
          expect(newUsers).toHaveLength(1);
          expect(newUsers[0]).toMatchObject({
            name: "After Reset",
            email: "after@example.com",
            age: 30,
          });

          // Cleanup
          await result.test.cleanup();
        }, 10000);
      });
    }
  });

  describe("multiple adapters with auth-like schema", () => {
    // Simplified auth schema for testing
    const authSchema = schema((s) => {
      return s
        .addTable("user", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("email", column("string"))
            .addColumn("passwordHash", column("string"))
            .createIndex("idx_user_email", ["email"]);
        })
        .addTable("session", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("userId", column("string"))
            .addColumn("expiresAt", column("timestamp"))
            .createIndex("idx_session_user", ["userId"]);
        });
    });

    const authFragmentDef = defineFragmentWithDatabase<{}>("auth-test")
      .withDatabase(authSchema)
      .withServices(({ orm }) => {
        return {
          createUser: async (email: string, passwordHash: string) => {
            const id = await orm.create("user", { email, passwordHash });
            return { id: id.valueOf(), email, passwordHash };
          },
          createSession: async (userId: string) => {
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + 30);
            const id = await orm.create("session", { userId, expiresAt });
            return { id: id.valueOf(), userId, expiresAt };
          },
          getUserByEmail: async (email: string) => {
            const user = await orm.findFirst("user", (b) =>
              b.whereIndex("idx_user_email", (eb) => eb("email", "=", email)),
            );
            if (!user) {
              return null;
            }
            return { id: user.id.valueOf(), email: user.email, passwordHash: user.passwordHash };
          },
        };
      });

    const adapters = [
      { name: "Kysely SQLite", adapter: { type: "kysely-sqlite" as const } },
      { name: "Kysely PGLite", adapter: { type: "kysely-pglite" as const } },
      { name: "Drizzle PGLite", adapter: { type: "drizzle-pglite" as const } },
    ];

    for (const { name, adapter } of adapters) {
      describe(name, () => {
        it("should create user and session", async () => {
          const { fragment, test } = await createDatabaseFragmentForTest(authFragmentDef, [], {
            adapter,
          });

          // Create a user
          const user = await fragment.services.createUser("test@test.com", "hashed-password");
          expect(user).toMatchObject({
            id: expect.any(String),
            email: "test@test.com",
            passwordHash: "hashed-password",
          });

          // Create a session for the user
          const session = await fragment.services.createSession(user.id);
          expect(session).toMatchObject({
            id: expect.any(String),
            userId: user.id,
            expiresAt: expect.any(Date),
          });

          // Find user by email
          const foundUser = await fragment.services.getUserByEmail("test@test.com");
          expect(foundUser).toMatchObject({
            id: user.id,
            email: "test@test.com",
            passwordHash: "hashed-password",
          });

          // Cleanup
          await test.cleanup();
        }, 10000);

        it("should return null when user not found", async () => {
          const { fragment, test } = await createDatabaseFragmentForTest(authFragmentDef, [], {
            adapter,
          });

          const notFound = await fragment.services.getUserByEmail("nonexistent@test.com");
          expect(notFound).toBeNull();

          await test.cleanup();
        }, 10000);
      });
    }
  });
});
