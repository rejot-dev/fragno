import { drizzle } from "drizzle-orm/pglite";
import { DrizzleAdapter } from "./drizzle-adapter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import { join } from "path";
import { writeFile } from "fs/promises";
import { mkdir } from "fs/promises";
import { generateSchema } from "./generate";
import type { DBType } from "./shared";
import { rm } from "fs/promises";
import { createRequire } from "node:module";

// Import drizzle-kit for migrations
const require = createRequire(import.meta.url);
const { generateDrizzleJson, generateMigration } =
  require("drizzle-kit/api") as typeof import("drizzle-kit/api");

describe("DrizzleAdapter PGLite", () => {
  const testSchema = schema((s) => {
    return s
      .addTable("users", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("age", column("integer").nullable());
      })
      .addTable("emails", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("user_id", referenceColumn())
          .addColumn("email", column("string"))
          .addColumn("is_primary", column("bool").defaultTo(false))
          .createIndex("unique_email", ["email"], { unique: true })
          .createIndex("user_emails", ["user_id"]);
      })
      .addReference("emails", "user", {
        columns: ["user_id"],
        targetTable: "users",
        targetColumns: ["id"],
      });
  });

  const tmpDir = join(import.meta.dirname, "_generated");
  let adapter: DrizzleAdapter;
  let schemaFilePath: string;
  let db: DBType;

  beforeAll(async () => {
    await mkdir(tmpDir, { recursive: true });

    // Generate schema file path
    schemaFilePath = join(tmpDir, `test-uow-schema-${Date.now()}.ts`);

    // Generate and write the Drizzle schema to file (using PostgreSQL)
    const drizzleSchemaTs = generateSchema(testSchema, "postgresql");
    await writeFile(schemaFilePath, drizzleSchemaTs, "utf-8");

    // Dynamically import the generated schema
    const schemaModule = await import(schemaFilePath);

    // Create Drizzle instance with PGLite (in-memory Postgres)
    db = drizzle({
      schema: schemaModule,
    }) as unknown as DBType;

    // Generate and run migrations
    const migrationStatements = await generateMigration(
      generateDrizzleJson({}), // Empty schema (starting state)
      generateDrizzleJson(schemaModule), // Target schema
    );

    // Execute migration SQL
    for (const statement of migrationStatements) {
      await db.execute(statement);
    }

    adapter = new DrizzleAdapter({
      db,
      provider: "postgresql",
    });
  }, 12000);

  afterAll(async () => {
    // Clean up the temp directory
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should execute Unit of Work with version checking", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "test");

    // Create initial user using UOW
    const createUow = queryEngine.createUnitOfWork("create-user").create("users", {
      name: "Alice",
      age: 25,
    });

    const { success: createSuccess } = await createUow.executeMutations();
    expect(createSuccess).toBe(true);

    // Fetch the created user to get its ID
    const [[initialUser]] = await queryEngine
      .createUnitOfWork("get-created-user")
      .find("users", (b) => b.whereIndex("primary"))
      .executeRetrieve();

    expect(initialUser).toBeDefined();
    expect(initialUser.name).toBe("Alice");
    expect(initialUser.id.version).toBe(0);

    const initialUserId = initialUser.id;

    // Build a UOW to update the user with optimistic locking
    const uow = queryEngine
      .createUnitOfWork("update-user-age")
      // Retrieval phase: find the user
      .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", initialUserId)));

    // Execute retrieval and transition to mutation phase
    const [users] = await uow.executeRetrieve();

    // Mutation phase: update with version check
    uow.update("users", initialUserId, (b) => b.set({ age: 26 }).check());

    // Execute mutations
    const { success } = await uow.executeMutations();

    // Should succeed
    expect(success).toBe(true);
    expect(users).toHaveLength(1);

    // Verify the user was updated
    const [[updatedUser]] = await queryEngine
      .createUnitOfWork("get-updated-user")
      .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", initialUserId)))
      .executeRetrieve();

    expect(updatedUser).toMatchObject({
      id: expect.objectContaining({
        externalId: initialUserId.externalId,
        version: 1, // Version incremented
      }),
      name: "Alice",
      age: 26,
    });

    // Try to update again with stale version (should fail)
    const uow2 = queryEngine.createUnitOfWork("update-user-stale");

    // Use the old version (0) which is now stale
    uow2.update("users", initialUserId, (b) => b.set({ age: 27 }).check());

    const { success: success2 } = await uow2.executeMutations();

    // Should fail due to version conflict
    expect(success2).toBe(false);

    // Verify the user was NOT updated
    const [[unchangedUser]] = await queryEngine
      .createUnitOfWork("verify-unchanged")
      .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", initialUserId)))
      .executeRetrieve();

    expect(unchangedUser).toMatchObject({
      id: expect.objectContaining({
        version: 1, // Still version 1
      }),
      age: 26, // Still 26, not 27
    });
  });
});
