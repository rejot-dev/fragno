import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { SQLocalDriverConfig } from "@fragno-dev/db/drivers";
import type { SimpleQueryInterface } from "@fragno-dev/db/query";
import type { AnySchema } from "@fragno-dev/db/schema";
import { Kysely } from "kysely";
import { SQLocalKysely } from "sqlocal/kysely";

import { internalFragmentDef } from "@fragno-dev/db";

import type { KyselySqliteAdapter, AdapterFactoryResult, SchemaConfig } from "../adapters";

const createCommonTestContextMethods = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ormMap: Map<string | null, SimpleQueryInterface<any, any>>,
) => ({
  getOrm: <TSchema extends AnySchema>(namespace: string | null): SimpleQueryInterface<TSchema> => {
    const orm = ormMap.get(namespace);
    if (!orm) {
      throw new Error(`No ORM found for namespace: ${String(namespace)}`);
    }
    return orm as SimpleQueryInterface<TSchema>;
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

export async function createKyselySqliteAdapter(
  config: KyselySqliteAdapter,
  schemas: SchemaConfig[],
): Promise<AdapterFactoryResult<KyselySqliteAdapter>> {
  let internalSchemaConfig: SchemaConfig | undefined;

  const createDatabase = async () => {
    const { dialect } = new SQLocalKysely(":memory:");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kysely = new Kysely<any>({
      dialect,
    });

    const adapter = new SqlAdapter({
      dialect,
      driverConfig: new SQLocalDriverConfig(),
      uowConfig: config.uowConfig,
    });
    internalSchemaConfig = await runInternalFragmentMigrations(adapter);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ormMap = new Map<string | null, SimpleQueryInterface<any, any>>();
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

    return { kysely, adapter, ormMap };
  };

  let { kysely, adapter, ormMap } = await createDatabase();

  const resetDatabase = async () => {
    const schemasToTruncate = internalSchemaConfig ? [internalSchemaConfig, ...schemas] : schemas;

    for (const { schema, namespace } of schemasToTruncate) {
      for (const tableName of Object.keys(schema.tables)) {
        const physicalTableName = adapter.namingStrategy.tableName(tableName, namespace);
        await kysely.deleteFrom(physicalTableName).execute();
      }
    }
  };

  const cleanup = async () => {
    await kysely.destroy();
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
