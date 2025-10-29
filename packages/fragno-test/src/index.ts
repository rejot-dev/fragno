import type { AnySchema } from "@fragno-dev/db/schema";
import {
  createFragmentForTest,
  type FragmentForTest,
  type CreateFragmentForTestOptions,
} from "@fragno-dev/core/test";
import type { FragnoPublicConfig } from "@fragno-dev/core/api/fragment-instantiation";
import type { FragmentDefinition } from "@fragno-dev/core/api/fragment-builder";
import {
  createAdapter,
  type SupportedAdapter,
  type TestContext,
  type KyselySqliteAdapter,
  type KyselyPgliteAdapter,
  type DrizzlePgliteAdapter,
} from "./adapters";

// Re-export utilities from @fragno-dev/core/test
export {
  createFragmentForTest,
  type TestResponse,
  type CreateFragmentForTestOptions,
  type RouteHandlerInputOptions,
  type FragmentForTest,
  type InitRoutesOverrides,
} from "@fragno-dev/core/test";

// Re-export adapter types
export type {
  SupportedAdapter,
  KyselySqliteAdapter,
  KyselyPgliteAdapter,
  DrizzlePgliteAdapter,
  TestContext,
} from "./adapters";

/**
 * Options for creating a database fragment for testing
 */
export interface CreateDatabaseFragmentForTestOptions<
  TConfig,
  TDeps,
  TServices,
  TAdditionalContext extends Record<string, unknown>,
  TOptions extends FragnoPublicConfig,
  TAdapter extends SupportedAdapter,
> extends Omit<
    CreateFragmentForTestOptions<TConfig, TDeps, TServices, TAdditionalContext, TOptions>,
    "config"
  > {
  adapter: TAdapter;
  migrateToVersion?: number;
  config?: TConfig;
}

/**
 * Result of creating a database fragment for testing
 * All properties are getters that return the current fragment instance
 */
export interface DatabaseFragmentTestResult<
  TConfig,
  TDeps,
  TServices,
  TAdditionalContext extends Record<string, unknown>,
  TOptions extends FragnoPublicConfig,
  TAdapter extends SupportedAdapter,
> {
  readonly fragment: FragmentForTest<TConfig, TDeps, TServices, TAdditionalContext, TOptions>;
  readonly services: TServices;
  readonly initRoutes: FragmentForTest<
    TConfig,
    TDeps,
    TServices,
    TAdditionalContext,
    TOptions
  >["initRoutes"];
  readonly handler: FragmentForTest<
    TConfig,
    TDeps,
    TServices,
    TAdditionalContext,
    TOptions
  >["handler"];
  readonly config: TConfig;
  readonly deps: TDeps;
  readonly additionalContext: TAdditionalContext;
  test: TestContext<TAdapter>;
}

export async function createDatabaseFragmentForTest<
  const TConfig,
  const TDeps,
  const TServices extends Record<string, unknown>,
  const TAdditionalContext extends Record<string, unknown>,
  const TOptions extends FragnoPublicConfig,
  const TSchema extends AnySchema,
  const TAdapter extends SupportedAdapter,
>(
  fragmentBuilder: {
    definition: FragmentDefinition<TConfig, TDeps, TServices, TAdditionalContext>;
    $requiredOptions: TOptions;
  },
  options: CreateDatabaseFragmentForTestOptions<
    TConfig,
    TDeps,
    TServices,
    TAdditionalContext,
    TOptions,
    TAdapter
  >,
): Promise<
  DatabaseFragmentTestResult<TConfig, TDeps, TServices, TAdditionalContext, TOptions, TAdapter>
> {
  const {
    adapter: adapterConfig,
    migrateToVersion,
    config,
    options: fragmentOptions,
    deps,
    services,
    additionalContext,
  } = options;

  // Get schema and namespace from fragment definition's additionalContext
  // Safe cast: DatabaseFragmentBuilder adds databaseSchema and databaseNamespace to additionalContext
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fragmentAdditionalContext = fragmentBuilder.definition.additionalContext as any;
  const schema = fragmentAdditionalContext?.databaseSchema as TSchema | undefined;
  const namespace = (fragmentAdditionalContext?.databaseNamespace as string | undefined) ?? "";

  if (!schema) {
    throw new Error(
      `Fragment '${fragmentBuilder.definition.name}' does not have a database schema. ` +
        `Make sure you're using defineFragmentWithDatabase().withDatabase(schema).`,
    );
  }

  // Create adapter using the factory
  const { testContext: originalTestContext, adapter } = await createAdapter(
    adapterConfig,
    schema,
    namespace,
    migrateToVersion,
  );

  // Create fragment with database adapter in options
  // Safe cast: We're merging the user's options with the databaseAdapter, which is required by TOptions
  // The user's TOptions is constrained to FragnoPublicConfig (or a subtype), which we extend with databaseAdapter
  let mergedOptions = {
    ...fragmentOptions,
    databaseAdapter: adapter,
  } as unknown as TOptions;

  // Safe cast: If config is not provided, we pass undefined as TConfig.
  // The base createFragmentForTest expects config: TConfig, but if TConfig allows undefined
  // or if the fragment doesn't use config in its dependencies function, this will work correctly.
  let fragment = createFragmentForTest(fragmentBuilder, {
    config: config as TConfig,
    options: mergedOptions,
    deps,
    services,
    additionalContext,
  });

  // Wrap resetDatabase to also recreate the fragment with the new adapter
  const originalResetDatabase = originalTestContext.resetDatabase;

  // Create test context with getters that always return current values
  // We need to cast to any to avoid TypeScript errors when accessing kysely/drizzle properties
  // that may not exist depending on the adapter type
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const testContext: any = Object.create(originalTestContext, {
    kysely: {
      get() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (originalTestContext as any).kysely;
      },
      enumerable: true,
    },
    drizzle: {
      get() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (originalTestContext as any).drizzle;
      },
      enumerable: true,
    },
    adapter: {
      get() {
        return originalTestContext.adapter;
      },
      enumerable: true,
    },
    resetDatabase: {
      value: async () => {
        // Call the original reset database function
        await originalResetDatabase();

        // Recreate the fragment with the new adapter (which has been updated by the factory's resetDatabase)
        mergedOptions = {
          ...fragmentOptions,
          databaseAdapter: originalTestContext.adapter,
        } as unknown as TOptions;

        fragment = createFragmentForTest(fragmentBuilder, {
          config: config as TConfig,
          options: mergedOptions,
          deps,
          services,
          additionalContext,
        });
      },
      enumerable: true,
    },
    cleanup: {
      value: async () => {
        await originalTestContext.cleanup();
      },
      enumerable: true,
    },
  });

  // Return an object with getters for fragment properties so they always reference the current fragment
  return {
    get fragment() {
      return fragment;
    },
    get services() {
      return fragment.services;
    },
    get initRoutes() {
      return fragment.initRoutes;
    },
    get handler() {
      return fragment.handler;
    },
    get config() {
      return fragment.config;
    },
    get deps() {
      return fragment.deps;
    },
    get additionalContext() {
      return fragment.additionalContext;
    },
    test: testContext,
  };
}
