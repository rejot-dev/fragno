import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { PGLiteDriverConfig } from "@fragno-dev/db/drivers";
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";

import type { FragnoDatabase } from "@fragno-dev/db";
import { internalFragmentDef } from "@fragno-dev/db";

import { createCommonTestContextMethods } from "..";
import type { AdapterFactoryResult, KyselyPgliteAdapter, SchemaConfig } from "../adapters";

const runInternalFragmentMigrations = async (
  adapter: SqlAdapter,
): Promise<SchemaConfig | undefined> => {
  const dependencies = internalFragmentDef.dependencies;
  if (!dependencies) {
    return undefined;
  }

  const databaseDeps = dependencies({
    config: {},
    options: { databaseAdapter: adapter, databaseNamespace: null },
  });
  if (databaseDeps?.schema) {
    const migrations = adapter.prepareMigrations(databaseDeps.schema, databaseDeps.namespace);
    await migrations.executeWithDriver(adapter.driver, 0);
    return { schema: databaseDeps.schema, namespace: databaseDeps.namespace };
  }
  return undefined;
};

const resolveSchemaName = (adapter: SqlAdapter, namespace: string | null): string | null => {
  if (adapter.namingStrategy.namespaceScope !== "schema") {
    return null;
  }
  if (!namespace || namespace.length === 0) {
    return null;
  }
  return adapter.namingStrategy.namespaceToSchema(namespace);
};

export async function createKyselyPgliteAdapter(
  config: KyselyPgliteAdapter,
  schemas: SchemaConfig[],
): Promise<AdapterFactoryResult<KyselyPgliteAdapter>> {
  const databasePath = config.databasePath;
  let internalSchemaConfig: SchemaConfig | undefined;

  const createDatabase = async () => {
    const kyselyPglite = await KyselyPGlite.create(databasePath);

    // oxlint-disable-next-line typescript/no-explicit-any
    const kysely = new Kysely<any>({
      dialect: kyselyPglite.dialect,
    });

    const adapter = new SqlAdapter({
      dialect: kyselyPglite.dialect,
      driverConfig: new PGLiteDriverConfig(),
      uowConfig: config.uowConfig,
    });
    internalSchemaConfig = await runInternalFragmentMigrations(adapter);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ormMap = new Map<string | null, FragnoDatabase<any, any>>();

    for (const { schema, namespace, migrateToVersion } of schemas) {
      const preparedMigrations = adapter.prepareMigrations(schema, namespace);
      if (migrateToVersion !== undefined) {
        await preparedMigrations.execute(0, migrateToVersion, {
          updateVersionInMigration: false,
        });
      } else {
        await preparedMigrations.execute(0, schema.version, { updateVersionInMigration: false });
      }

      const orm = adapter.createQueryEngine(schema, namespace);
      ormMap.set(namespace, orm);
    }

    return { kysely, adapter, kyselyPglite, ormMap };
  };

  const { kysely, adapter, kyselyPglite, ormMap } = await createDatabase();

  const resetDatabase = async () => {
    if (databasePath && databasePath !== ":memory:") {
      throw new Error("resetDatabase is only supported for in-memory databases");
    }

    const schemasToTruncate = internalSchemaConfig ? [internalSchemaConfig, ...schemas] : schemas;

    for (const { schema, namespace } of schemasToTruncate) {
      for (const tableName of Object.keys(schema.tables)) {
        const physicalTableName = adapter.namingStrategy.tableName(tableName, namespace);
        const schemaName = resolveSchemaName(adapter, namespace);
        const scopedKysely = schemaName ? kysely.withSchema(schemaName) : kysely;
        await scopedKysely.deleteFrom(physicalTableName).execute();
      }
    }
  };

  const cleanup = async () => {
    await kysely.destroy();

    try {
      await kyselyPglite.client.close();
    } catch {
      // Ignore if already closed
    }

    if (databasePath && databasePath !== ":memory:" && existsSync(databasePath)) {
      await rm(databasePath, { recursive: true, force: true });
    }
  };

  const commonMethods = createCommonTestContextMethods(ormMap);

  return {
    testContext: {
      get kysely() {
        return kysely;
      },
      get adapter() {
        return adapter;
      },
      ...commonMethods,
      resetDatabase,
      cleanup,
    },
    get adapter() {
      return adapter;
    },
  };
}
