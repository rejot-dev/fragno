import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { PGLiteDriverConfig } from "@fragno-dev/db/drivers";
import type { AnySchema } from "@fragno-dev/db/schema";
import { drizzle } from "drizzle-orm/pglite";
import { KyselyPGlite } from "kysely-pglite";

import type { FragnoDatabase } from "@fragno-dev/db";
import { internalFragmentDef } from "@fragno-dev/db";

import { PGlite } from "@electric-sql/pglite";

import type { AdapterFactoryResult, DrizzlePgliteAdapter, SchemaConfig } from "../adapters";

const createCommonTestContextMethods = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ormMap: Map<string | null, FragnoDatabase<any, any>>,
) => ({
  getOrm: <TSchema extends AnySchema>(namespace: string | null): FragnoDatabase<TSchema> => {
    const orm = ormMap.get(namespace);
    if (!orm) {
      throw new Error(`No ORM found for namespace: ${String(namespace)}`);
    }
    return orm as FragnoDatabase<TSchema>;
  },
});

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

export async function createDrizzlePgliteAdapter(
  config: DrizzlePgliteAdapter,
  schemas: SchemaConfig[],
): Promise<AdapterFactoryResult<DrizzlePgliteAdapter>> {
  const databasePath = config.databasePath;
  let internalSchemaConfig: SchemaConfig | undefined;

  const createDatabase = async () => {
    const pglite = new PGlite(databasePath);
    const { dialect } = new KyselyPGlite(pglite);

    const adapter = new SqlAdapter({
      dialect,
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

    // oxlint-disable-next-line typescript/no-explicit-any
    const db = drizzle(pglite) as any;

    return { drizzle: db, adapter, ormMap };
  };

  const { drizzle: drizzleDb, adapter, ormMap } = await createDatabase();

  const resetDatabase = async () => {
    if (databasePath && databasePath !== ":memory:") {
      throw new Error("resetDatabase is only supported for in-memory databases");
    }

    const schemasToTruncate = internalSchemaConfig ? [internalSchemaConfig, ...schemas] : schemas;
    const useTruncate = adapter.adapterMetadata?.databaseType === "postgresql";

    for (const { schema, namespace } of schemasToTruncate) {
      const tableNames = Object.keys(schema.tables);
      if (useTruncate) {
        const qualifiedTables = tableNames.map((tableName) => {
          const physicalTableName = adapter.namingStrategy.tableName(tableName, namespace);
          const schemaName = resolveSchemaName(adapter, namespace);
          return schemaName ? `"${schemaName}"."${physicalTableName}"` : `"${physicalTableName}"`;
        });
        if (qualifiedTables.length > 0) {
          await drizzleDb.execute(`TRUNCATE ${qualifiedTables.join(", ")} CASCADE`);
        }
        continue;
      }

      for (const tableName of tableNames.slice().reverse()) {
        const physicalTableName = adapter.namingStrategy.tableName(tableName, namespace);
        const schemaName = resolveSchemaName(adapter, namespace);
        const qualifiedTable = schemaName
          ? `"${schemaName}"."${physicalTableName}"`
          : `"${physicalTableName}"`;
        await drizzleDb.execute(`DELETE FROM ${qualifiedTable}`);
      }
    }
  };

  const cleanup = async () => {
    await adapter.close();

    if (databasePath && databasePath !== ":memory:" && existsSync(databasePath)) {
      await rm(databasePath, { recursive: true, force: true });
    }
  };

  const commonMethods = createCommonTestContextMethods(ormMap);

  return {
    testContext: {
      get drizzle() {
        return drizzleDb;
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
