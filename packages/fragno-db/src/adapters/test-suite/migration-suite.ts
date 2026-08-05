import { describe, expect, it } from "vitest";

import {
  internalSchema,
  SETTINGS_TABLE_NAME,
  SYSTEM_MIGRATION_VERSION_KEY,
} from "../../fragments/internal-fragment";
import type { AnySchema } from "../../schema/create";
import type { MigrationSuiteHarness } from "./migration-suite-harness";
import { migrationSuiteSchema } from "./migration-suite-schema";

const namespace = "migration_suite_contract";

export function describeMigrationSuite(harness: MigrationSuiteHarness): void {
  describe(`migration contract: ${harness.name}`, () => {
    const createContext = async () => {
      const context = await harness.createAdapter();
      if (!context.adapter.prepareMigrations) {
        throw new Error(`${harness.name} does not support prepareMigrations`);
      }
      return context;
    };

    const migrate = async (
      adapter: Awaited<ReturnType<typeof createContext>>["adapter"],
      schema: AnySchema,
      schemaNamespace: string | null,
      fromVersion: number,
      toVersion = schema.version,
      options?: { systemFromVersion?: number; systemToVersion?: number },
    ) => {
      await adapter.prepareMigrations!(schema, schemaNamespace).execute(
        fromVersion,
        toVersion,
        options,
      );
    };

    const migrateInternal = async (
      adapter: Awaited<ReturnType<typeof createContext>>["adapter"],
    ) => {
      await migrate(adapter, internalSchema, "", 0, internalSchema.version, {
        systemFromVersion: 0,
      });
    };

    it("creates the final schema from an empty database", async () => {
      const { adapter, close } = await createContext();
      try {
        await migrateInternal(adapter);
        await migrate(adapter, migrationSuiteSchema, namespace, 0, migrationSuiteSchema.version, {
          systemFromVersion: 0,
        });

        const observed = await harness.inspector.inspectSchema({
          adapter,
          schema: migrationSuiteSchema,
          namespace,
        });

        expect(observed.tables["users"]?.exists).toBe(true);
        expect(observed.tables["posts"]?.exists).toBe(true);
        expect(observed.tables["users"]?.columns["id"]?.exists).toBe(true);
        expect(observed.tables["users"]?.columns["email"]?.exists).toBe(true);
        expect(observed.tables["users"]?.columns["name"]).toMatchObject({
          exists: true,
          nullable: true,
        });
        expect(observed.tables["users"]?.columns["age"]).toMatchObject({
          exists: true,
          nullable: true,
          logicalType: "integer",
        });
        expect(observed.tables["users"]?.columns["_internalId"]?.exists).toBe(true);
        expect(observed.tables["users"]?.columns["_version"]).toMatchObject({
          exists: true,
          defaultKind: "zero",
        });
        expect(observed.tables["users"]?.columns["_shard"]).toMatchObject({
          exists: true,
          nullable: false,
          defaultKind: "global-shard",
        });
        expect(observed.tables["users"]?.indexes["users_email_idx"]).toMatchObject({
          exists: true,
          unique: true,
          columns: ["email"],
        });
        expect(observed.tables["posts"]?.indexes["posts_author_idx"]).toMatchObject({
          exists: true,
          columns: ["authorId"],
        });
        expect(observed.settings[`${namespace}.schema_version`]).toBe(
          String(migrationSuiteSchema.version),
        );
        expect(observed.settings[`${namespace}.${SYSTEM_MIGRATION_VERSION_KEY}`]).toBeDefined();
      } finally {
        await close?.();
      }
    });

    it("reaches the same final schema when applied one version at a time", async () => {
      const fresh = await createContext();
      const stepped = await createContext();
      try {
        await migrateInternal(fresh.adapter);
        await migrate(
          fresh.adapter,
          migrationSuiteSchema,
          namespace,
          0,
          migrationSuiteSchema.version,
          {
            systemFromVersion: 0,
          },
        );

        await migrateInternal(stepped.adapter);
        for (let version = 0; version < migrationSuiteSchema.version; version += 1) {
          await migrate(stepped.adapter, migrationSuiteSchema, namespace, version, version + 1, {
            systemFromVersion: version === 0 ? 0 : undefined,
          });
        }

        const freshObserved = await harness.inspector.inspectSchema({
          adapter: fresh.adapter,
          schema: migrationSuiteSchema,
          namespace,
        });
        const steppedObserved = await harness.inspector.inspectSchema({
          adapter: stepped.adapter,
          schema: migrationSuiteSchema,
          namespace,
        });

        expect(steppedObserved.tables).toEqual(freshObserved.tables);
      } finally {
        await fresh.close?.();
        await stepped.close?.();
      }
    });

    it("applies system migrations to a legacy pre-system schema", async () => {
      const { adapter, close } = await createContext();
      try {
        await migrateInternal(adapter);
        await harness.inspector.bootstrapLegacyV1({
          adapter,
          schema: migrationSuiteSchema,
          namespace,
        });
        await seedSetting(
          adapter,
          namespace,
          "schema_version",
          String(migrationSuiteSchema.version),
        );

        await migrate(
          adapter,
          migrationSuiteSchema,
          namespace,
          migrationSuiteSchema.version,
          migrationSuiteSchema.version,
          {
            systemFromVersion: 0,
          },
        );

        const observed = await harness.inspector.inspectSchema({
          adapter,
          schema: migrationSuiteSchema,
          namespace,
        });
        expect(observed.tables["users"]?.columns["_shard"]).toMatchObject({
          exists: true,
          nullable: false,
          defaultKind: "global-shard",
        });
        expect(observed.tables["users"]?.indexes["idx_users_shard"]).toMatchObject({
          exists: true,
          columns: ["_shard"],
        });
        expect(observed.settings[`${namespace}.schema_version`]).toBe(
          String(migrationSuiteSchema.version),
        );
        expect(observed.settings[`${namespace}.${SYSTEM_MIGRATION_VERSION_KEY}`]).toBeDefined();
      } finally {
        await close?.();
      }
    });

    it("rejects backwards schema migrations", async () => {
      const { adapter, close } = await createContext();
      try {
        await migrateInternal(adapter);
        await expect(migrate(adapter, migrationSuiteSchema, namespace, 2, 1)).rejects.toThrow(
          "Cannot migrate backwards",
        );
      } finally {
        await close?.();
      }
    });

    it("runs system migrations when schema version is already current", async () => {
      const { adapter, close } = await createContext();
      try {
        await migrateInternal(adapter);
        await harness.inspector.bootstrapLegacyV1({
          adapter,
          schema: migrationSuiteSchema,
          namespace,
        });
        await seedSetting(
          adapter,
          namespace,
          "schema_version",
          String(migrationSuiteSchema.version),
        );
        await migrate(
          adapter,
          migrationSuiteSchema,
          namespace,
          migrationSuiteSchema.version,
          migrationSuiteSchema.version,
          {
            systemFromVersion: 0,
            systemToVersion: 0,
          },
        );

        await migrate(
          adapter,
          migrationSuiteSchema,
          namespace,
          migrationSuiteSchema.version,
          migrationSuiteSchema.version,
          {
            systemFromVersion: 0,
          },
        );

        const observed = await harness.inspector.inspectSchema({
          adapter,
          schema: migrationSuiteSchema,
          namespace,
        });
        expect(observed.tables["users"]?.columns["_shard"]?.exists).toBe(true);
        expect(observed.settings[`${namespace}.${SYSTEM_MIGRATION_VERSION_KEY}`]).toBeDefined();
      } finally {
        await close?.();
      }
    });
  });
}

async function seedSetting(
  adapter: Awaited<ReturnType<MigrationSuiteHarness["createAdapter"]>>["adapter"],
  settingNamespace: string,
  key: string,
  value: string,
): Promise<void> {
  const uow = adapter.createUnitOfWork(
    internalSchema,
    "",
    `seed-setting-${settingNamespace}-${key}`,
  );
  uow.create(SETTINGS_TABLE_NAME, { key: `${settingNamespace}.${key}`, value });
  await uow.executeMutations();
}
