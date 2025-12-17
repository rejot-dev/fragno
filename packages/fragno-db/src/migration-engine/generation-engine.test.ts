import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from "vitest";
import { DummyDriver, MysqlAdapter, PostgresAdapter, SqliteAdapter } from "kysely";
import {
  postProcessMigrationFilenames,
  type GenerationInternalResult,
  generateMigrationsOrSchema,
} from "./generation-engine";
import { KyselyAdapter } from "../adapters/kysely/kysely-adapter";
import { column, idColumn, schema, type AnySchema } from "../schema/create";
import { FragnoDatabase } from "../mod";
import {
  MySQL2DriverConfig,
  NodePostgresDriverConfig,
  SQLocalDriverConfig,
} from "../adapters/generic-sql/driver-config";

describe("generateMigrationsOrSchema - kysely", () => {
  const mockDate = new Date("2025-10-24T12:00:00Z");
  let adapter: KyselyAdapter;

  beforeAll(() => {
    adapter = new KyselyAdapter({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createQueryCompiler: () => ({
          compileQuery: () => ({
            sql: "",
            parameters: [],
          }),
        }),
      },
      driverConfig: new NodePostgresDriverConfig(),
    });

    // Mock the adapter methods
    vi.spyOn(adapter, "isConnectionHealthy").mockResolvedValue(true);
    vi.spyOn(adapter, "getSchemaVersion").mockResolvedValue(undefined);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(mockDate);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should generate migration for single database from version 0", async () => {
    const testSchema: AnySchema = schema((s) => {
      return s.addTable("users", (t) => {
        return t.addColumn("id", idColumn()).addColumn("name", column("string"));
      });
    });

    const fragnoDb = new FragnoDatabase({
      namespace: "test-db",
      schema: testSchema,
      adapter,
    });

    const results = await generateMigrationsOrSchema([fragnoDb]);

    expect(results).toHaveLength(2); // Settings + test-db
    expect(results[0].namespace).toBe(""); // Empty namespace for settings table
    expect(results[0].path).toMatch(/^20251024_001_f000_t00\d_fragno_db_settings.sql$/);
    expect(results[0].schema).toContain("create table");
    expect(results[0].schema).toContain("fragno_db_settings");

    expect(results[1].namespace).toBe("test-db");
    expect(results[1].path).toBe("20251024_002_f000_t001_test-db.sql");
    expect(results[1].schema).toContain("create table");
    expect(results[1].schema).toContain("users_test-db");
  });

  it("should generate migrations for multiple databases in alphabetical order", async () => {
    const schema1: AnySchema = schema((s) => {
      return s.addTable("users", (t) => {
        return t.addColumn("id", idColumn()).addColumn("name", column("string"));
      });
    });

    const schema2: AnySchema = schema((s) => {
      return s.addTable("posts", (t) => {
        return t.addColumn("id", idColumn()).addColumn("title", column("string"));
      });
    });

    const schema3: AnySchema = schema((s) => {
      return s.addTable("comments", (t) => {
        return t.addColumn("id", idColumn()).addColumn("text", column("string"));
      });
    });

    const fragnoDb1 = new FragnoDatabase({
      namespace: "zebra-db",
      schema: schema1,
      adapter,
    });

    const fragnoDb2 = new FragnoDatabase({
      namespace: "apple-db",
      schema: schema2,
      adapter,
    });

    const fragnoDb3 = new FragnoDatabase({
      namespace: "mango-db",
      schema: schema3,
      adapter,
    });

    const results = await generateMigrationsOrSchema([fragnoDb1, fragnoDb2, fragnoDb3]);

    expect(results).toHaveLength(4); // Settings + 3 databases
    expect(results[0].namespace).toBe(""); // Empty namespace for settings table
    expect(results[0].path).toMatch(/^20251024_001_f000_t00\d_fragno_db_settings.sql$/);

    expect(results[1].namespace).toBe("apple-db");
    expect(results[1].path).toBe("20251024_002_f000_t001_apple-db.sql");
    expect(results[1].schema).toContain("posts_apple-db");

    expect(results[2].namespace).toBe("mango-db");
    expect(results[2].path).toBe("20251024_003_f000_t001_mango-db.sql");
    expect(results[2].schema).toContain("comments_mango-db");

    expect(results[3].namespace).toBe("zebra-db");
    expect(results[3].path).toBe("20251024_004_f000_t001_zebra-db.sql");
    expect(results[3].schema).toContain("users_zebra-db");
  });

  it("should handle existing settings version and generate both settings and fragment migrations", async () => {
    const testSchema: AnySchema = schema((s) => {
      return s
        .addTable("users", (t) => {
          return t.addColumn("id", idColumn()).addColumn("name", column("string"));
        })
        .alterTable("users", (t) => {
          return t.addColumn("age", column("integer").nullable());
        });
    });

    // Override getSchemaVersion for this test - settings already at version 1
    vi.spyOn(adapter, "getSchemaVersion").mockResolvedValueOnce("1");

    const fragnoDb = new FragnoDatabase({
      namespace: "test-db",
      schema: testSchema,
      adapter,
    });

    const results = await generateMigrationsOrSchema([fragnoDb]);

    // Settings table already at version 1, so no settings migration needed
    // But fragment migration is still generated
    expect(results).toHaveLength(2);
    expect(results[0].namespace).toBe(""); // Empty namespace for settings table
    expect(results[1].namespace).toBe("test-db");
    expect(results[1].path).toBe("20251024_002_f000_t002_test-db.sql");
    expect(results[1].schema).toContain("create table");
    expect(results[1].schema).toContain("alter table");
  });

  it("should generate settings migration even with no fragment changes", async () => {
    const testSchema: AnySchema = schema((s) => {
      return s.addTable("users", (t) => {
        return t.addColumn("id", idColumn()).addColumn("name", column("string"));
      });
    });

    const fragnoDb = new FragnoDatabase({
      namespace: "test-db",
      schema: testSchema,
      adapter,
    });

    // Generate with toVersion = 0, fromVersion = 0 (no fragment changes)
    const results = await generateMigrationsOrSchema([fragnoDb], {
      toVersion: 0,
      fromVersion: 0,
    });

    // Settings migration is generated, but no fragment migration (since toVersion=0)
    expect(results).toHaveLength(1);
    expect(results[0].namespace).toBe(""); // Empty namespace for settings table
  });

  it("should throw error when no databases provided", async () => {
    await expect(generateMigrationsOrSchema([])).rejects.toThrow(
      "No databases provided for schema generation",
    );
  });

  it("should throw error when database connection is unhealthy", async () => {
    const testSchema: AnySchema = schema((s) => {
      return s.addTable("users", (t) => {
        return t.addColumn("id", idColumn()).addColumn("name", column("string"));
      });
    });

    // Mock unhealthy connection for this test
    vi.spyOn(adapter, "isConnectionHealthy").mockResolvedValueOnce(false);

    const fragnoDb = new FragnoDatabase({
      namespace: "test-db",
      schema: testSchema,
      adapter,
    });

    await expect(generateMigrationsOrSchema([fragnoDb])).rejects.toThrow(
      "Database connection is not healthy",
    );
  });

  it("should generate SQL with correct version tracking in settings", async () => {
    const testSchema: AnySchema = schema((s) => {
      return s.addTable("users", (t) => {
        return t.addColumn("id", idColumn()).addColumn("name", column("string"));
      });
    });

    const fragnoDb = new FragnoDatabase({
      namespace: "test-db",
      schema: testSchema,
      adapter,
    });

    const results = await generateMigrationsOrSchema([fragnoDb]);

    // Check settings migration includes version tracking
    expect(results[0].schema).toContain("fragno_db_settings");
    expect(results[0].schema).toContain("key");
    expect(results[0].schema).toContain("value");

    // Check fragment migration includes version tracking
    expect(results[1].schema).toContain("test-db.schema_version");
    expect(results[1].schema).toContain("'1'");
  });

  it("should generate INSERT for version 0->N and UPDATE for version N->M", async () => {
    const testSchema: AnySchema = schema((s) => {
      return s
        .addTable("users", (t) => {
          return t.addColumn("id", idColumn()).addColumn("name", column("string"));
        })
        .alterTable("users", (t) => {
          return t.addColumn("email", column("string").nullable());
        });
    });

    const fragnoDb = new FragnoDatabase({
      namespace: "test-db",
      schema: testSchema,
      adapter,
    });

    // First migration: 0 -> 1 (should use INSERT)
    vi.spyOn(adapter, "getSchemaVersion").mockResolvedValueOnce(undefined);
    const resultsV1 = await generateMigrationsOrSchema([fragnoDb], {
      fromVersion: 0,
      toVersion: 1,
    });

    expect(resultsV1).toHaveLength(2); // Settings + test-db
    // Check that fragment migration contains INSERT for version tracking
    expect(resultsV1[1].schema).toContain("insert into");
    expect(resultsV1[1].schema).toContain("test-db.schema_version");
    expect(resultsV1[1].schema).toContain("'1'");
    expect(resultsV1[1].schema).toMatchInlineSnapshot(`
      "create table "users_test-db" ("id" varchar(30) not null unique, "name" text not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      insert into "fragno_db_settings" ("id", "key", "value") values ('6_U2SCfiaNG9VyYmQ_JwzQ', 'test-db.schema_version', '1');"
    `);

    // Second migration: 1 -> 2 (should use UPDATE)
    vi.spyOn(adapter, "getSchemaVersion").mockResolvedValueOnce("1");
    const resultsV2 = await generateMigrationsOrSchema([fragnoDb], {
      fromVersion: 1,
      toVersion: 2,
    });

    expect(resultsV2).toHaveLength(2); // Settings + test-db
    // Check that fragment migration contains UPDATE for version tracking
    expect(resultsV2[1].schema).toContain("update");
    expect(resultsV2[1].schema).toContain("fragno_db_settings");
    expect(resultsV2[1].schema).toContain("test-db.schema_version");
    expect(resultsV2[1].schema).toContain("'2'");
    expect(resultsV2[1].schema).toMatchInlineSnapshot(`
      "alter table "users_test-db" add column "email" text;

      update "fragno_db_settings" set "value" = '2' where "key" = 'test-db.schema_version';"
    `);
  });

  it("should include MySQL-specific foreign key checks in generated SQL", async () => {
    const mysqlAdapter = new KyselyAdapter({
      dialect: {
        createAdapter: () => new MysqlAdapter(),
        createDriver: () => new DummyDriver(),
        createQueryCompiler: () => ({
          compileQuery: () => ({
            sql: "",
            parameters: [],
          }),
        }),
      },
      driverConfig: new MySQL2DriverConfig(),
    });

    vi.spyOn(mysqlAdapter, "isConnectionHealthy").mockResolvedValue(true);
    vi.spyOn(mysqlAdapter, "getSchemaVersion").mockResolvedValue(undefined);

    const testSchema: AnySchema = schema((s) => {
      return s.addTable("users", (t) => {
        return t.addColumn("id", idColumn()).addColumn("name", column("string"));
      });
    });

    const fragnoDb = new FragnoDatabase({
      namespace: "test-db",
      schema: testSchema,
      adapter: mysqlAdapter,
    });

    const results = await generateMigrationsOrSchema([fragnoDb]);

    expect(results).toHaveLength(2);
    // Check that MySQL foreign key checks are included
    expect(results[1].schema).toContain("SET FOREIGN_KEY_CHECKS = 0");
    expect(results[1].schema).toContain("SET FOREIGN_KEY_CHECKS = 1");
    // Verify they're in the correct order
    const schemaContent = results[1].schema;
    const fkCheckOffIndex = schemaContent.indexOf("SET FOREIGN_KEY_CHECKS = 0");
    const fkCheckOnIndex = schemaContent.indexOf("SET FOREIGN_KEY_CHECKS = 1");
    const createTableIndex = schemaContent.indexOf("create table");
    expect(fkCheckOffIndex).toBeLessThan(createTableIndex);
    expect(createTableIndex).toBeLessThan(fkCheckOnIndex);
  });

  it("should include SQLite-specific pragma in generated SQL", async () => {
    const sqliteAdapter = new KyselyAdapter({
      dialect: {
        createAdapter: () => new SqliteAdapter(),
        createDriver: () => new DummyDriver(),
        createQueryCompiler: () => ({
          compileQuery: () => ({
            sql: "",
            parameters: [],
          }),
        }),
      },
      driverConfig: new SQLocalDriverConfig(),
    });

    vi.spyOn(sqliteAdapter, "isConnectionHealthy").mockResolvedValue(true);
    vi.spyOn(sqliteAdapter, "getSchemaVersion").mockResolvedValue(undefined);

    const testSchema: AnySchema = schema((s) => {
      return s.addTable("users", (t) => {
        return t.addColumn("id", idColumn()).addColumn("name", column("string"));
      });
    });

    const fragnoDb = new FragnoDatabase({
      namespace: "test-db",
      schema: testSchema,
      adapter: sqliteAdapter,
    });

    const results = await generateMigrationsOrSchema([fragnoDb]);

    expect(results).toHaveLength(2);
    // Check that SQLite pragma is included
    expect(results[1].schema).toContain("PRAGMA defer_foreign_keys = ON");
    // Verify it's at the beginning
    const schemaContent = results[1].schema;
    const pragmaIndex = schemaContent.indexOf("PRAGMA defer_foreign_keys = ON");
    const createTableIndex = schemaContent.indexOf("create table");
    expect(pragmaIndex).toBeLessThan(createTableIndex);
  });
});

describe("postProcessMigrationFilenames", () => {
  const mockDate = new Date("2025-10-24T12:00:00Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(mockDate);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should return empty array when given empty input", () => {
    const result = postProcessMigrationFilenames([]);
    expect(result).toEqual([]);
  });

  it("should order settings namespace first", () => {
    const files: GenerationInternalResult[] = [
      {
        schema: "schema1",
        path: "placeholder.sql",
        namespace: "fragno-db-comment-db",
        fromVersion: 0,
        toVersion: 3,
      },
      {
        schema: "schema2",
        path: "placeholder.sql",
        namespace: "", // Empty namespace for settings table
        fromVersion: 0,
        toVersion: 1,
      },
      {
        schema: "schema3",
        path: "placeholder.sql",
        namespace: "fragno-db-rating-db",
        fromVersion: 0,
        toVersion: 2,
      },
    ];

    const result = postProcessMigrationFilenames(files);

    expect(result).toHaveLength(3);
    expect(result[0].namespace).toBe(""); // Empty namespace for settings table
    expect(result[0].path).toBe("20251024_001_f000_t001_fragno_db_settings.sql");
  });

  it("should sort non-settings namespaces alphabetically", () => {
    const files: GenerationInternalResult[] = [
      {
        schema: "schema1",
        path: "placeholder.sql",
        namespace: "zebra-db",
        fromVersion: 0,
        toVersion: 1,
      },
      {
        schema: "schema2",
        path: "placeholder.sql",
        namespace: "apple-db",
        fromVersion: 0,
        toVersion: 1,
      },
      {
        schema: "schema3",
        path: "placeholder.sql",
        namespace: "mango-db",
        fromVersion: 0,
        toVersion: 1,
      },
    ];

    const result = postProcessMigrationFilenames(files);

    expect(result).toHaveLength(3);
    expect(result[0].namespace).toBe("apple-db");
    expect(result[1].namespace).toBe("mango-db");
    expect(result[2].namespace).toBe("zebra-db");
  });

  it("should format filename with correct ordering and version numbers", () => {
    const files: GenerationInternalResult[] = [
      {
        schema: "CREATE TABLE users;",
        path: "placeholder.sql",
        namespace: "", // Empty namespace for settings table
        fromVersion: 0,
        toVersion: 5,
      },
      {
        schema: "CREATE TABLE comments;",
        path: "placeholder.sql",
        namespace: "comment-db",
        fromVersion: 5,
        toVersion: 10,
      },
    ];

    const result = postProcessMigrationFilenames(files);

    expect(result[0].path).toBe("20251024_001_f000_t005_fragno_db_settings.sql");
    expect(result[1].path).toBe("20251024_002_f005_t010_comment-db.sql");
  });

  it("should pad numbers to 3 digits", () => {
    const files: GenerationInternalResult[] = [
      {
        schema: "schema",
        path: "placeholder.sql",
        namespace: "test-db",
        fromVersion: 99,
        toVersion: 999,
      },
    ];

    const result = postProcessMigrationFilenames(files);

    expect(result[0].path).toBe("20251024_001_f099_t999_test-db.sql");
  });

  it("should sanitize namespace with invalid characters", () => {
    const files: GenerationInternalResult[] = [
      {
        schema: "schema",
        path: "placeholder.sql",
        namespace: "test@db#special!chars",
        fromVersion: 0,
        toVersion: 1,
      },
    ];

    const result = postProcessMigrationFilenames(files);

    expect(result[0].path).toBe("20251024_001_f000_t001_test_db_special_chars.sql");
  });

  it("should preserve schema content", () => {
    const files: GenerationInternalResult[] = [
      {
        schema: "CREATE TABLE users (id INT);",
        path: "placeholder.sql",
        namespace: "user-db",
        fromVersion: 0,
        toVersion: 1,
      },
    ];

    const result = postProcessMigrationFilenames(files);

    expect(result[0].schema).toBe("CREATE TABLE users (id INT);");
  });

  it("should handle multiple files with settings first and others sorted", () => {
    const files: GenerationInternalResult[] = [
      {
        schema: "schema1",
        path: "placeholder.sql",
        namespace: "zoo-db",
        fromVersion: 1,
        toVersion: 2,
      },
      {
        schema: "schema2",
        path: "placeholder.sql",
        namespace: "", // Empty namespace for settings table
        fromVersion: 0,
        toVersion: 5,
      },
      {
        schema: "schema3",
        path: "placeholder.sql",
        namespace: "apple-db",
        fromVersion: 3,
        toVersion: 4,
      },
      {
        schema: "schema4",
        path: "placeholder.sql",
        namespace: "mango-db",
        fromVersion: 2,
        toVersion: 3,
      },
    ];

    const result = postProcessMigrationFilenames(files);

    expect(result).toHaveLength(4);
    expect(result[0].namespace).toBe(""); // Empty namespace for settings table
    expect(result[0].path).toBe("20251024_001_f000_t005_fragno_db_settings.sql");
    expect(result[1].namespace).toBe("apple-db");
    expect(result[1].path).toBe("20251024_002_f003_t004_apple-db.sql");
    expect(result[2].namespace).toBe("mango-db");
    expect(result[2].path).toBe("20251024_003_f002_t003_mango-db.sql");
    expect(result[3].namespace).toBe("zoo-db");
    expect(result[3].path).toBe("20251024_004_f001_t002_zoo-db.sql");
  });

  it("should handle ordering numbers beyond 100", () => {
    const files: GenerationInternalResult[] = Array.from({ length: 150 }, (_, i) => ({
      schema: `schema${i}`,
      path: "placeholder.sql",
      namespace: `db-${String(i).padStart(3, "0")}`,
      fromVersion: 0,
      toVersion: 1,
    }));

    const result = postProcessMigrationFilenames(files);

    expect(result).toHaveLength(150);
    expect(result[99].path).toContain("_100_");
    expect(result[149].path).toContain("_150_");
  });

  it("should preserve hyphens in namespace", () => {
    const files: GenerationInternalResult[] = [
      {
        schema: "schema",
        path: "placeholder.sql",
        namespace: "my-awesome-db-fragment",
        fromVersion: 0,
        toVersion: 1,
      },
    ];

    const result = postProcessMigrationFilenames(files);

    expect(result[0].path).toBe("20251024_001_f000_t001_my-awesome-db-fragment.sql");
  });

  it("should use current date in YYYYMMDD format", () => {
    const files: GenerationInternalResult[] = [
      {
        schema: "schema",
        path: "placeholder.sql",
        namespace: "test-db",
        fromVersion: 0,
        toVersion: 1,
      },
    ];

    const result = postProcessMigrationFilenames(files);

    expect(result[0].path).toMatch(/^20251024_/);
  });
});
