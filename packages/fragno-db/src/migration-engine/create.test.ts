import { describe, expect, it, vi } from "vitest";
import { createMigrator, type MigrationEngineOptions } from "./create";
import { schema, idColumn, column, referenceColumn } from "../schema/create";
import type { MigrationOperation } from "./shared";

describe("createMigrator", () => {
  const testSchema = schema("test", (s) => {
    return s
      .addTable("users", (t) => {
        return t.addColumn("id", idColumn()).addColumn("name", column("string"));
      })
      .addTable("posts", (t) => {
        return t.addColumn("id", idColumn()).addColumn("title", column("string"));
      })
      .addTable("comments", (t) => {
        return t.addColumn("id", idColumn()).addColumn("text", column("string"));
      });
  });

  function createTestMigrator(currentVersion = 0) {
    const executedOperations: MigrationOperation[][] = [];
    let version = currentVersion;

    const options: MigrationEngineOptions = {
      schema: testSchema,
      executor: async (operations) => {
        executedOperations.push(operations);
      },
      settings: {
        getVersion: async () => version,
        updateSettingsInMigration: async (_fromVersion, toVersion) => {
          version = toVersion;
          return [
            {
              type: "custom",
              sql: `UPDATE _settings SET version = ${toVersion}`,
            },
          ];
        },
      },
    };

    const migrator = createMigrator(options);

    return { migrator, executedOperations, getVersion: () => version };
  }

  describe("migrate()", () => {
    it("should migrate from version 0 to latest schema version", async () => {
      const { migrator, getVersion } = createTestMigrator(0);

      const result = await migrator.prepareMigration();

      expect(result.operations.length).toBeGreaterThan(0);
      expect(getVersion()).toBe(testSchema.version);
    });

    it("should migrate from intermediate version to latest", async () => {
      const { migrator, getVersion } = createTestMigrator(1);

      const result = await migrator.prepareMigration();

      expect(result.operations.length).toBeGreaterThan(0);
      expect(getVersion()).toBe(testSchema.version);
    });

    it("should return empty operations when already at latest version", async () => {
      const { migrator, getVersion } = createTestMigrator(testSchema.version);

      const result = await migrator.prepareMigration();

      expect(result.operations).toEqual([]);
      expect(getVersion()).toBe(testSchema.version);
    });

    it("should generate correct operations when jumping multiple versions", async () => {
      const { migrator } = createTestMigrator(0);

      const result = await migrator.prepareMigration();

      // Should create all 3 tables plus settings update
      const createTableOps = result.operations.filter((op) => op.type === "create-table");
      expect(createTableOps).toHaveLength(3);
    });
  });

  describe("migrateTo()", () => {
    it("should migrate forward from version 0 to version 2", async () => {
      const { migrator, getVersion } = createTestMigrator(0);

      const result = await migrator.prepareMigrationTo(2);

      expect(result.operations.length).toBeGreaterThan(0);
      expect(getVersion()).toBe(2);
    });

    it("should migrate forward by jumping multiple versions", async () => {
      const { migrator, getVersion } = createTestMigrator(0);

      const result = await migrator.prepareMigrationTo(testSchema.version);

      expect(getVersion()).toBe(testSchema.version);
      const createTableOps = result.operations.filter((op) => op.type === "create-table");
      expect(createTableOps).toHaveLength(3);
    });

    it("should migrate forward one version at a time", async () => {
      const { migrator, getVersion } = createTestMigrator(0);

      await migrator.prepareMigrationTo(1);
      expect(getVersion()).toBe(1);

      await migrator.prepareMigrationTo(2);
      expect(getVersion()).toBe(2);

      await migrator.prepareMigrationTo(3);
      expect(getVersion()).toBe(3);
    });

    it("should return empty operations when already at target version", async () => {
      const { migrator, getVersion } = createTestMigrator(2);

      const result = await migrator.prepareMigrationTo(2);

      expect(result.operations).toEqual([]);
      expect(getVersion()).toBe(2);
    });

    it("should throw error when trying to migrate backwards", async () => {
      const { migrator } = createTestMigrator(3);

      await expect(migrator.prepareMigrationTo(1)).rejects.toThrow(
        "Cannot migrate backwards: current version is 3, target is 1. Only forward migrations are supported.",
      );
    });

    it("should throw error when migrating to negative version", async () => {
      const { migrator } = createTestMigrator(0);

      await expect(migrator.prepareMigrationTo(-1)).rejects.toThrow(
        "Cannot migrate to negative version: -1",
      );
    });

    it("should throw error when migrating beyond schema version", async () => {
      const { migrator } = createTestMigrator(0);

      await expect(migrator.prepareMigrationTo(999)).rejects.toThrow(
        `Cannot migrate to version 999: schema only has version ${testSchema.version}`,
      );
    });
  });

  describe("getVersion()", () => {
    it("should return current version", async () => {
      const { migrator } = createTestMigrator(0);

      const version = await migrator.getVersion();

      expect(version).toBe(0);
    });

    it("should return updated version after migration", async () => {
      const { migrator } = createTestMigrator(0);

      await migrator.prepareMigrationTo(2);
      const version = await migrator.getVersion();

      expect(version).toBe(2);
    });
  });

  describe("execute()", () => {
    it("should execute migration operations", async () => {
      const { migrator, executedOperations } = createTestMigrator(0);

      const result = await migrator.prepareMigrationTo(1);
      await result.execute();

      expect(executedOperations).toHaveLength(1);
      expect(executedOperations[0].length).toBeGreaterThan(0);
    });

    it("should not execute operations until execute() is called", async () => {
      const { migrator, executedOperations } = createTestMigrator(0);

      await migrator.prepareMigrationTo(1);

      expect(executedOperations).toHaveLength(0);
    });
  });

  describe("transformers", () => {
    it("should apply afterAuto transformer", async () => {
      const executedOperations: MigrationOperation[][] = [];
      let version = 0;

      const afterAutoSpy = vi.fn((operations) => {
        return [
          ...operations,
          {
            type: "custom",
            sql: "-- Added by afterAuto",
          },
        ];
      });

      const options: MigrationEngineOptions = {
        schema: testSchema,
        executor: async (operations) => {
          executedOperations.push(operations);
        },
        settings: {
          getVersion: async () => version,
          updateSettingsInMigration: async (_fromVersion, toVersion) => {
            version = toVersion;
            return [];
          },
        },
        transformers: [
          {
            afterAuto: afterAutoSpy,
          },
        ],
      };

      const migrator = createMigrator(options);
      const result = await migrator.prepareMigrationTo(1);

      expect(afterAutoSpy).toHaveBeenCalledOnce();
      expect(result.operations.some((op) => op.type === "custom")).toBe(true);
    });

    it("should apply afterAll transformer", async () => {
      const executedOperations: MigrationOperation[][] = [];
      let version = 0;

      const afterAllSpy = vi.fn((operations) => {
        return [
          ...operations,
          {
            type: "custom",
            sql: "-- Added by afterAll",
          },
        ];
      });

      const options: MigrationEngineOptions = {
        schema: testSchema,
        executor: async (operations) => {
          executedOperations.push(operations);
        },
        settings: {
          getVersion: async () => version,
          updateSettingsInMigration: async (_fromVersion, toVersion) => {
            version = toVersion;
            return [];
          },
        },
        transformers: [
          {
            afterAll: afterAllSpy,
          },
        ],
      };

      const migrator = createMigrator(options);
      const result = await migrator.prepareMigrationTo(1);

      expect(afterAllSpy).toHaveBeenCalledOnce();
      expect(result.operations.some((op) => op.type === "custom")).toBe(true);
    });
  });

  describe("updateSettings option", () => {
    it("should update settings by default", async () => {
      const { migrator } = createTestMigrator(0);

      const result = await migrator.prepareMigrationTo(1);

      const settingsOp = result.operations.find((op) => op.type === "custom");
      expect(settingsOp).toBeDefined();
    });

    it("should skip settings update when updateSettings is false", async () => {
      const { migrator } = createTestMigrator(0);

      const result = await migrator.prepareMigrationTo(1, { updateSettings: false });

      // When updateSettings is false, we shouldn't have the settings update operation
      // Check that we only have create-table operations
      const nonTableOps = result.operations.filter((op) => op.type !== "create-table");
      expect(nonTableOps).toHaveLength(0);
    });
  });

  describe("with foreign keys", () => {
    it("should handle schema with foreign keys", async () => {
      const fkSchema = schema("fk", (s) => {
        return s
          .addTable("users", (t) => {
            return t.addColumn("id", idColumn());
          })
          .addTable("posts", (t) => {
            return t.addColumn("id", idColumn()).addColumn("authorId", referenceColumn());
          })
          .addReference("author", {
            type: "one",
            from: { table: "posts", column: "authorId" },
            to: { table: "users", column: "id" },
          });
      });

      let version = 0;
      const options: MigrationEngineOptions = {
        schema: fkSchema,
        executor: async () => {},
        settings: {
          getVersion: async () => version,
          updateSettingsInMigration: async (_fromVersion, toVersion) => {
            version = toVersion;
            return [];
          },
        },
      };

      const migrator = createMigrator(options);
      const result = await migrator.prepareMigration();

      const createTableOps = result.operations.filter((op) => op.type === "create-table");
      const fkOps = result.operations.filter((op) => op.type === "add-foreign-key");

      expect(createTableOps).toHaveLength(2);
      expect(fkOps).toHaveLength(1);
    });
  });
});
