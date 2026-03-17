import type { DatabaseAdapter } from "@fragno-dev/db/adapters";
import type { InMemoryAdapterOptions } from "@fragno-dev/db/adapters/in-memory";
import type { UnitOfWorkConfig } from "@fragno-dev/db/adapters/sql";
import type { SimpleQueryInterface } from "@fragno-dev/db/query";
import type { AnySchema } from "@fragno-dev/db/schema";
import type { drizzle } from "drizzle-orm/pglite";
import type { Kysely } from "kysely";

import type { BaseTestContext } from ".";

export interface KyselySqliteAdapter {
  type: "kysely-sqlite";
  uowConfig?: UnitOfWorkConfig;
}

export interface KyselyPgliteAdapter {
  type: "kysely-pglite";
  databasePath?: string;
  uowConfig?: UnitOfWorkConfig;
}

export interface DrizzlePgliteAdapter {
  type: "drizzle-pglite";
  databasePath?: string;
  uowConfig?: UnitOfWorkConfig;
}

export interface InMemoryAdapterConfig {
  type: "in-memory";
  options?: InMemoryAdapterOptions;
  uowConfig?: UnitOfWorkConfig;
}

export interface ModelCheckerAdapterConfig {
  type: "model-checker";
  options?: InMemoryAdapterOptions;
}

export type SupportedAdapter =
  | KyselySqliteAdapter
  | KyselyPgliteAdapter
  | DrizzlePgliteAdapter
  | InMemoryAdapterConfig
  | ModelCheckerAdapterConfig;

export interface SchemaConfig {
  schema: AnySchema;
  namespace: string | null;
  migrateToVersion?: number;
}

interface InternalTestContext extends BaseTestContext {
  getOrm: <TSchema extends AnySchema>(namespace: string | null) => SimpleQueryInterface<TSchema>;
}

export type AdapterContext<T extends SupportedAdapter> = T extends
  | KyselySqliteAdapter
  | KyselyPgliteAdapter
  ? {
      readonly kysely: Kysely<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    }
  : T extends DrizzlePgliteAdapter
    ? {
        readonly drizzle: ReturnType<typeof drizzle<any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
      }
    : T extends InMemoryAdapterConfig | ModelCheckerAdapterConfig
      ? {}
      : never;

export interface AdapterFactoryResult<T extends SupportedAdapter> {
  testContext: InternalTestContext & AdapterContext<T>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adapter: DatabaseAdapter<any>;
}

export async function createAdapter<T extends SupportedAdapter>(
  adapterConfig: T,
  schemas: SchemaConfig[],
): Promise<AdapterFactoryResult<T>> {
  if (adapterConfig.type === "kysely-sqlite") {
    const { createKyselySqliteAdapter } = await import("./test-adapters/kysely-sqlite");
    return createKyselySqliteAdapter(adapterConfig, schemas) as Promise<AdapterFactoryResult<T>>;
  }

  if (adapterConfig.type === "kysely-pglite") {
    const { createKyselyPgliteAdapter } = await import("./test-adapters/kysely-pglite");
    return createKyselyPgliteAdapter(adapterConfig, schemas) as Promise<AdapterFactoryResult<T>>;
  }

  if (adapterConfig.type === "drizzle-pglite") {
    const { createDrizzlePgliteAdapter } = await import("./test-adapters/drizzle-pglite");
    return createDrizzlePgliteAdapter(adapterConfig, schemas) as Promise<AdapterFactoryResult<T>>;
  }

  if (adapterConfig.type === "in-memory") {
    const { createInMemoryAdapter } = await import("./test-adapters/in-memory");
    return createInMemoryAdapter(adapterConfig, schemas) as Promise<AdapterFactoryResult<T>>;
  }

  if (adapterConfig.type === "model-checker") {
    const { createModelCheckerAdapter } = await import("./test-adapters/model-checker");
    return createModelCheckerAdapter(adapterConfig, schemas) as Promise<AdapterFactoryResult<T>>;
  }

  throw new Error(`Unsupported adapter type: ${(adapterConfig as SupportedAdapter).type}`);
}
