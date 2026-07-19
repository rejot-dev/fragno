import { InMemoryAdapter } from "@fragno-dev/db/adapters/in-memory";

import type { AdapterFactoryResult, InMemoryAdapterConfig, SchemaConfig } from "../adapters";
import { createCommonTestContextMethods } from "../common-test-context";
import type { TestUnitOfWorkFactory } from "../test-db";

export async function createInMemoryAdapter(
  config: InMemoryAdapterConfig,
  schemas: SchemaConfig[],
): Promise<AdapterFactoryResult<InMemoryAdapterConfig>> {
  const adapter = new InMemoryAdapter(config.options);

  const unitOfWorkFactories = new Map<string | null, TestUnitOfWorkFactory>();
  for (const { schema, namespace } of schemas) {
    adapter.registerSchema(schema, namespace);
    unitOfWorkFactories.set(namespace, (name, uowConfig) =>
      adapter.createBaseUnitOfWork(name, uowConfig as never),
    );
  }

  const resetDatabase = async () => {
    await adapter.reset();
  };

  const cleanup = async () => {
    await adapter.close();
  };

  const commonMethods = createCommonTestContextMethods(unitOfWorkFactories);

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
    createAdditionalAdapter: async () => adapter.fork(),
  };
}
