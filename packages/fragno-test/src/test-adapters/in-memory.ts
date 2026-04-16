import { InMemoryAdapter } from "@fragno-dev/db/adapters/in-memory";
import type { AnySchema } from "@fragno-dev/db/schema";

import type { FragnoDatabase } from "@fragno-dev/db";

import type { AdapterFactoryResult, InMemoryAdapterConfig, SchemaConfig } from "../adapters";

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

export async function createInMemoryAdapter(
  config: InMemoryAdapterConfig,
  schemas: SchemaConfig[],
): Promise<AdapterFactoryResult<InMemoryAdapterConfig>> {
  const adapter = new InMemoryAdapter(config.options);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ormMap = new Map<string | null, FragnoDatabase<any, any>>();
  for (const { schema, namespace } of schemas) {
    const orm = adapter.createQueryEngine(schema, namespace);
    ormMap.set(namespace, orm);
  }

  const resetDatabase = async () => {
    await adapter.reset();
  };

  const cleanup = async () => {
    await adapter.close();
  };

  const commonMethods = createCommonTestContextMethods(ormMap);

  return {
    testContext: {
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
