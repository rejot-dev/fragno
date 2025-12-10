import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { column, FragnoId, idColumn, referenceColumn, schema } from "../../schema/create";
import type { DBType } from "./shared";
import { writeAndLoadSchema } from "./test-utils";
import { fromDrizzle } from "./drizzle-query";
import { createDrizzleConnectionPool } from "./drizzle-connection-pool";
import type { ConnectionPool } from "../../shared/connection-pool";
import type { DrizzleCompiledQuery } from "./drizzle-uow-compiler";

describe("drizzle-query", () => {
  const authSchema = schema((s) => {
    return s
      .addTable("user", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("email", column("string"))
          .addColumn("passwordHash", column("string"))
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo$((b) => b.now()),
          )
          .createIndex("idx_user_email", ["email"]);
      })
      .addTable("session", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("userId", referenceColumn())
          .addColumn("expiresAt", column("timestamp"))
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo$((b) => b.now()),
          )
          .createIndex("idx_session_user", ["userId"]);
      })
      .addReference("sessionOwner", {
        from: {
          table: "session",
          column: "userId",
        },
        to: {
          table: "user",
          column: "id",
        },
        type: "one",
      });
  });

  let db: DBType;
  let pool: ConnectionPool<DBType>;
  let orm: ReturnType<typeof fromDrizzle<typeof authSchema>>;

  const queries: DrizzleCompiledQuery[] = [];

  beforeAll(async () => {
    // Write schema to file and dynamically import it
    const { schemaModule, cleanup, drizzleSchemaTs } = await writeAndLoadSchema(
      "drizzle-query-auth",
      authSchema,
      "postgresql",
    );

    console.log(drizzleSchemaTs);

    // Create Drizzle instance with PGLite (in-memory Postgres)
    db = drizzle({
      schema: schemaModule,
    }) as unknown as DBType;

    // Create connection pool and ORM instance
    pool = createDrizzleConnectionPool(db);
    orm = fromDrizzle(authSchema, pool, "postgresql", undefined, {
      onQuery: (query) => {
        queries.push(query);
      },
      dryRun: true,
    });

    return async () => {
      await cleanup();
    };
  });

  beforeEach(() => {
    queries.splice(0, queries.length);
  });

  describe("findFirst", () => {
    it("should find session with user join", async () => {
      const someExternalId = "some-external-id";

      // Find the session with user join
      await orm.findFirst("session", (b) =>
        b
          .whereIndex("primary", (eb) => eb("id", "=", someExternalId))
          .join((j) => j.sessionOwner((b) => b.select(["id", "email"]))),
      );

      const [query] = queries;
      expect(query.sql).toMatchInlineSnapshot(
        `"select "session"."id", "session"."userId", "session"."expiresAt", "session"."createdAt", "session"."_internalId", "session"."_version", "session_sessionOwner"."data" as "sessionOwner" from "session" "session" left join lateral (select json_build_array("session_sessionOwner"."id", "session_sessionOwner"."email", "session_sessionOwner"."_internalId", "session_sessionOwner"."_version") as "data" from (select * from "user" "session_sessionOwner" where "session_sessionOwner"."_internalId" = "session"."userId" limit $1) "session_sessionOwner") "session_sessionOwner" on true where "session"."id" = $2 limit $3"`,
      );
      expect(query.params).toEqual([1, someExternalId, 1]);
    });

    it("should find session without join", async () => {
      const someExternalId = "some-external-id";

      await orm.findFirst("session", (b) =>
        b.whereIndex("primary", (eb) => eb("id", "=", someExternalId)),
      );

      const [query] = queries;
      expect(query.sql).toMatchInlineSnapshot(
        `"select "id", "userId", "expiresAt", "createdAt", "_internalId", "_version" from "session" "session" where "session"."id" = $1 limit $2"`,
      );
      expect(query.params).toEqual([someExternalId, 1]);
    });

    it("should find user by email using custom index", async () => {
      const email = "test@example.com";

      await orm.findFirst("user", (b) =>
        b.whereIndex("idx_user_email", (eb) => eb("email", "=", email)),
      );

      const [query] = queries;
      expect(query.sql).toMatchInlineSnapshot(
        `"select "id", "email", "passwordHash", "createdAt", "_internalId", "_version" from "user" "user" where "user"."email" = $1 limit $2"`,
      );
      expect(query.params).toEqual([email, 1]);
    });

    it("should find with select subset of columns", async () => {
      const someExternalId = "some-external-id";

      const res = await orm.findFirst("user", (b) =>
        b.whereIndex("primary", (eb) => eb("id", "=", someExternalId)).select(["id", "email"]),
      );

      if (res) {
        expectTypeOf(res.email).toEqualTypeOf<string>();
      }

      const [query] = queries;
      expect(query.sql).toMatchInlineSnapshot(
        `"select "id", "email", "_internalId", "_version" from "user" "user" where "user"."id" = $1 limit $2"`,
      );
      expect(query.params).toEqual([someExternalId, 1]);
    });
  });

  describe("find", () => {
    it("should find all sessions using primary index", async () => {
      await orm.find("session", (b) => b.whereIndex("primary"));

      const [query] = queries;
      expect(query.sql).toMatchInlineSnapshot(
        `"select "id", "userId", "expiresAt", "createdAt", "_internalId", "_version" from "session" "session""`,
      );
      expect(query.params).toEqual([]);
    });

    it("should find sessions with user join", async () => {
      await orm.find("session", (b) =>
        b.whereIndex("primary").join((j) => j.sessionOwner((b) => b.select(["id", "email"]))),
      );

      const [query] = queries;
      expect(query.sql).toMatchInlineSnapshot(
        `"select "session"."id", "session"."userId", "session"."expiresAt", "session"."createdAt", "session"."_internalId", "session"."_version", "session_sessionOwner"."data" as "sessionOwner" from "session" "session" left join lateral (select json_build_array("session_sessionOwner"."id", "session_sessionOwner"."email", "session_sessionOwner"."_internalId", "session_sessionOwner"."_version") as "data" from (select * from "user" "session_sessionOwner" where "session_sessionOwner"."_internalId" = "session"."userId" limit $1) "session_sessionOwner") "session_sessionOwner" on true"`,
      );
      expect(query.params).toEqual([1]);
    });

    it("should find sessions with where clause using custom index", async () => {
      const userId = "user-123";

      await orm.find("session", (b) =>
        b.whereIndex("idx_session_user", (eb) => eb("userId", "=", userId)),
      );

      const [query] = queries;
      expect(query.sql).toMatchInlineSnapshot(
        `"select "id", "userId", "expiresAt", "createdAt", "_internalId", "_version" from "session" "session" where "session"."userId" = (select "_internalId" from "user" where "id" = $1 limit 1)"`,
      );
      expect(query.params).toEqual([userId]);
    });

    it("should find with pageSize", async () => {
      await orm.find("user", (b) => b.whereIndex("primary").pageSize(10));

      const [query] = queries;
      expect(query.sql).toMatchInlineSnapshot(
        `"select "id", "email", "passwordHash", "createdAt", "_internalId", "_version" from "user" "user" limit $1"`,
      );
      expect(query.params).toEqual([10]);
    });

    it("should find with select subset", async () => {
      const _res = await orm.find("user", (b) => b.whereIndex("primary").select(["id", "email"]));

      const [query] = queries;
      expect(query.sql).toMatchInlineSnapshot(
        `"select "id", "email", "_internalId", "_version" from "user" "user""`,
      );
      expect(query.params).toEqual([]);
    });
  });

  describe("create", () => {
    it("should create a new user", async () => {
      const createdId = await orm.create("user", {
        id: "user-123",
        email: "test@example.com",
        passwordHash: "hashed-password",
      });

      // Verify the operation succeeded by getting the created ID (FragnoId object)
      expect(createdId).toBeDefined();
      expect(typeof createdId).toBe("object");

      // Verify the SQL query was captured
      const [query] = queries;
      expect(query.sql).toMatchInlineSnapshot(
        `"insert into "user" ("id", "email", "passwordHash", "createdAt", "_internalId", "_version") values ($1, $2, $3, $4, default, default)"`,
      );
      expect(query.params[0]).toEqual("user-123");
      expect(query.params[1]).toEqual("test@example.com");
      expect(query.params[2]).toEqual("hashed-password");
      expect(typeof query.params[3]).toBe("string"); // createdAt timestamp (serialized)
      expect(query.params[3]).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO format
    });

    it("should create a new session", async () => {
      const expiresAt = new Date("2025-12-31T23:59:59Z");

      const createdId = await orm.create("session", {
        id: "session-456",
        userId: "user-123",
        expiresAt,
      });

      // Verify the operation succeeded by getting the created ID (FragnoId object)
      expect(createdId).toBeDefined();
      expect(typeof createdId).toBe("object");

      // Verify the SQL query was captured
      const [query] = queries;
      expect(query.sql).toMatchInlineSnapshot(
        `"insert into "session" ("id", "userId", "expiresAt", "createdAt", "_internalId", "_version") values ($1, (select "_internalId" from "user" where "id" = $2 limit 1), $3, $4, default, default)"`,
      );
      expect(query.params[0]).toEqual("session-456");
      expect(query.params[1]).toEqual("user-123"); // userId is resolved via subquery
      expect(query.params[2]).toEqual(expiresAt.toISOString());
      expect(typeof query.params[3]).toBe("string"); // createdAt timestamp (serialized)
      expect(query.params[3]).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO format
    });
  });

  describe("createMany", () => {
    it("should create multiple users", async () => {
      const createdIds = await orm.createMany("user", [
        {
          id: "user-1",
          email: "user1@example.com",
          passwordHash: "hash1",
        },
        {
          id: "user-2",
          email: "user2@example.com",
          passwordHash: "hash2",
        },
      ]);

      // Verify the operation succeeded by checking we got IDs back (FragnoId objects)
      expect(createdIds).toHaveLength(2);
      expect(typeof createdIds[0]).toBe("object");
      expect(typeof createdIds[1]).toBe("object");

      // Verify the SQL queries were captured
      // createMany should generate one insert per record
      expect(queries).toHaveLength(2);

      // Check the first user insert
      expect(queries[0].sql).toMatchInlineSnapshot(
        `"insert into "user" ("id", "email", "passwordHash", "createdAt", "_internalId", "_version") values ($1, $2, $3, $4, default, default)"`,
      );
      expect(queries[0].params[0]).toEqual("user-1");
      expect(queries[0].params[1]).toEqual("user1@example.com");
      expect(queries[0].params[2]).toEqual("hash1");

      // Check the second user insert
      expect(queries[1].sql).toMatchInlineSnapshot(
        `"insert into "user" ("id", "email", "passwordHash", "createdAt", "_internalId", "_version") values ($1, $2, $3, $4, default, default)"`,
      );
      expect(queries[1].params[0]).toEqual("user-2");
      expect(queries[1].params[1]).toEqual("user2@example.com");
      expect(queries[1].params[2]).toEqual("hash2");
    });
  });

  describe("update", () => {
    it("should update user by id", async () => {
      const userId = "user-123";

      await orm.update("user", userId, (b) =>
        b.set({
          email: "newemail@example.com",
        }),
      );

      // Verify the SQL query was captured
      const [query] = queries;
      expect(query.sql).toMatchInlineSnapshot(
        `"update "user" set "email" = $1, "_version" = COALESCE(_version, 0) + 1 where "user"."id" = $2"`,
      );
      expect(query.params).toEqual(["newemail@example.com", userId]);
    });

    it("should update session expiration", async () => {
      const sessionId = "session-456";
      const newExpiresAt = new Date("2026-01-01T00:00:00Z");

      await orm.update("session", sessionId, (b) =>
        b.set({
          expiresAt: newExpiresAt,
        }),
      );

      // Verify the SQL query was captured
      const [query] = queries;
      expect(query.sql).toMatchInlineSnapshot(
        `"update "session" set "expiresAt" = $1, "_version" = COALESCE(_version, 0) + 1 where "session"."id" = $2"`,
      );
      expect(query.params).toEqual([newExpiresAt.toISOString(), sessionId]);
    });

    it("should update with version check using FragnoId", async () => {
      const userId = FragnoId.fromExternal("user-123", 5);

      await orm.update("user", userId, (b) =>
        b
          .set({
            email: "checked@example.com",
          })
          .check(),
      );

      // Verify the SQL query includes version check in WHERE clause
      const [query] = queries;
      expect(query.sql).toMatchInlineSnapshot(
        `"update "user" set "email" = $1, "_version" = COALESCE(_version, 0) + 1 where ("user"."id" = $2 and "user"."_version" = $3)"`,
      );
      expect(query.params).toEqual(["checked@example.com", "user-123", 5]);
    });

    it("should throw when trying to check() with string ID", async () => {
      await expect(
        orm.update("user", "user-123", (b) => b.set({ email: "test@example.com" }).check()),
      ).rejects.toThrow(
        'Cannot use check() with a string ID on table "user". Version checking requires a FragnoId with version information.',
      );
    });
  });

  describe("updateMany", () => {
    it("should update multiple users by index", async () => {
      await orm.updateMany("user", (b) =>
        b
          .whereIndex("idx_user_email", (eb) => eb("email", "=", "old@example.com"))
          .set({ email: "new@example.com" }),
      );

      // updateMany first finds matching records, then updates them
      expect(queries.length).toBeGreaterThan(0);

      // Verify the find query that's executed first
      const findQuery = queries[0];
      expect(findQuery.sql).toMatchInlineSnapshot(
        `"select "id", "email", "passwordHash", "createdAt", "_internalId", "_version" from "user" "user" where "user"."email" = $1"`,
      );
      expect(findQuery.params).toEqual(["old@example.com"]);

      // Note: In dryRun mode, no actual records are found, so no update queries are generated
      // This is expected behavior - updateMany only generates update queries for found records
    });
  });

  describe("delete", () => {
    it("should delete user by id", async () => {
      const userId = "user-123";

      await orm.delete("user", userId);

      // Verify the SQL query was captured
      const [query] = queries;
      expect(query.sql).toMatchInlineSnapshot(`"delete from "user" where "user"."id" = $1"`);
      expect(query.params).toEqual([userId]);
    });

    it("should delete session by id", async () => {
      const sessionId = "session-456";

      await orm.delete("session", sessionId);

      // Verify the SQL query was captured
      const [query] = queries;
      expect(query.sql).toMatchInlineSnapshot(`"delete from "session" where "session"."id" = $1"`);
      expect(query.params).toEqual([sessionId]);
    });

    it("should delete with version check using FragnoId", async () => {
      const userId = FragnoId.fromExternal("user-789", 3);

      await orm.delete("user", userId, (b) => b.check());

      // Verify the SQL query includes version check in WHERE clause
      const [query] = queries;
      expect(query.sql).toMatchInlineSnapshot(
        `"delete from "user" where ("user"."id" = $1 and "user"."_version" = $2)"`,
      );
      expect(query.params).toEqual(["user-789", 3]);
    });

    it("should throw when trying to check() with string ID on delete", async () => {
      await expect(orm.delete("user", "user-123", (b) => b.check())).rejects.toThrow(
        'Cannot use check() with a string ID on table "user". Version checking requires a FragnoId with version information.',
      );
    });
  });

  describe("deleteMany", () => {
    it("should delete sessions by userId using index", async () => {
      const userId = "user-123";

      await orm.deleteMany("session", (b) =>
        b.whereIndex("idx_session_user", (eb) => eb("userId", "=", userId)),
      );

      // deleteMany first finds matching records, then deletes them
      expect(queries.length).toBeGreaterThan(0);

      // Verify the find query that's executed first
      const findQuery = queries[0];
      expect(findQuery.sql).toMatchInlineSnapshot(
        `"select "id", "userId", "expiresAt", "createdAt", "_internalId", "_version" from "session" "session" where "session"."userId" = (select "_internalId" from "user" where "id" = $1 limit 1)"`,
      );
      expect(findQuery.params).toEqual([userId]);

      // Note: In dryRun mode, no actual records are found, so no delete queries are generated
      // This is expected behavior - deleteMany only generates delete queries for found records
    });
  });

  describe("FragnoId support", () => {
    it("should accept FragnoId in delete", async () => {
      // Create a user first to get a FragnoId
      const createdId = await orm.create("user", {
        id: "fragno-user-123",
        email: "fragno@example.com",
        passwordHash: "hash",
      });

      // Clear queries from create
      queries.splice(0, queries.length);

      // Now delete using the FragnoId
      await orm.delete("user", createdId);

      // Verify the SQL query was captured with the external ID
      const [query] = queries;
      expect(query.sql).toMatchInlineSnapshot(`"delete from "user" where "user"."id" = $1"`);
      expect(query.params).toEqual(["fragno-user-123"]);
    });

    it("should accept FragnoId in update", async () => {
      // Create a user first to get a FragnoId
      const createdId = await orm.create("user", {
        id: "fragno-user-456",
        email: "update@example.com",
        passwordHash: "hash",
      });

      // Clear queries from create
      queries.splice(0, queries.length);

      // Now update using the FragnoId
      await orm.update("user", createdId, (b) => b.set({ email: "updated@example.com" }));

      // Verify the SQL query was captured with the external ID
      const [query] = queries;
      expect(query.sql).toMatchInlineSnapshot(
        `"update "user" set "email" = $1, "_version" = COALESCE(_version, 0) + 1 where "user"."id" = $2"`,
      );
      expect(query.params).toEqual(["updated@example.com", "fragno-user-456"]);
    });
  });
});
