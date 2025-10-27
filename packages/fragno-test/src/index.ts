import { Kysely } from "kysely";
import { SQLocalKysely } from "sqlocal/kysely";
import { KyselyAdapter } from "@fragno-dev/db/adapters/kysely";
import type { AnySchema } from "@fragno-dev/db/schema";
import type { DatabaseAdapter } from "@fragno-dev/db/adapters";
import {
  createFragmentForTest,
  type FragmentForTest,
  type CreateFragmentForTestOptions,
} from "@fragno-dev/core/test";
import type { FragnoPublicConfig } from "@fragno-dev/core/api/fragment-instantiation";
import type { FragmentDefinition } from "@fragno-dev/core/api/fragment-builder";

// Re-export utilities from @fragno-dev/core/test
export {
  createFragmentForTest,
  type TestResponse,
  type CreateFragmentForTestOptions,
  type RouteHandlerInputOptions,
  type FragmentForTest,
  type InitRoutesOverrides,
} from "@fragno-dev/core/test";

/**
 * Options for creating a database fragment for testing
 */
export interface CreateDatabaseFragmentForTestOptions<
  TConfig,
  TDeps,
  TServices,
  TAdditionalContext extends Record<string, unknown>,
  TOptions extends FragnoPublicConfig,
> extends Omit<
    CreateFragmentForTestOptions<TConfig, TDeps, TServices, TAdditionalContext, TOptions>,
    "config"
  > {
  databasePath?: string;
  migrateToVersion?: number;
  config?: TConfig;
}

/**
 * Extended fragment test instance with database adapter and Kysely instance
 */
export interface DatabaseFragmentForTest<
  TConfig,
  TDeps,
  TServices,
  TAdditionalContext extends Record<string, unknown>,
  TOptions extends FragnoPublicConfig,
> extends FragmentForTest<TConfig, TDeps, TServices, TAdditionalContext, TOptions> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kysely: Kysely<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adapter: DatabaseAdapter<any>;
}

export async function createDatabaseFragmentForTest<
  const TConfig,
  const TDeps,
  const TServices extends Record<string, unknown>,
  const TAdditionalContext extends Record<string, unknown>,
  const TOptions extends FragnoPublicConfig,
  const TSchema extends AnySchema,
>(
  fragmentBuilder: {
    definition: FragmentDefinition<TConfig, TDeps, TServices, TAdditionalContext>;
    $requiredOptions: TOptions;
  },
  options?: CreateDatabaseFragmentForTestOptions<
    TConfig,
    TDeps,
    TServices,
    TAdditionalContext,
    TOptions
  >,
): Promise<DatabaseFragmentForTest<TConfig, TDeps, TServices, TAdditionalContext, TOptions>> {
  const {
    databasePath = ":memory:",
    migrateToVersion,
    config,
    options: fragmentOptions,
    deps,
    services,
    additionalContext,
  } = options ?? {};

  // Create SQLocalKysely instance
  const { dialect } = new SQLocalKysely(databasePath);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const kysely = new Kysely<any>({
    dialect,
  });

  // Create KyselyAdapter
  const adapter = new KyselyAdapter({
    db: kysely,
    provider: "sqlite",
  });

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

  // Run migrations automatically
  const migrator = adapter.createMigrationEngine(schema, namespace);
  const preparedMigration = migrateToVersion
    ? await migrator.prepareMigrationTo(migrateToVersion, {
        updateSettings: false,
      })
    : await migrator.prepareMigration({
        updateSettings: false,
      });
  await preparedMigration.execute();

  // Create fragment with database adapter in options
  // Safe cast: We're merging the user's options with the databaseAdapter, which is required by TOptions
  // The user's TOptions is constrained to FragnoPublicConfig (or a subtype), which we extend with databaseAdapter
  const mergedOptions = {
    ...fragmentOptions,
    databaseAdapter: adapter,
  } as unknown as TOptions;

  // Safe cast: If config is not provided, we pass undefined as TConfig.
  // The base createFragmentForTest expects config: TConfig, but if TConfig allows undefined
  // or if the fragment doesn't use config in its dependencies function, this will work correctly.
  const fragment = createFragmentForTest(fragmentBuilder, {
    config: config as TConfig,
    options: mergedOptions,
    deps,
    services,
    additionalContext,
  });

  return {
    ...fragment,
    kysely,
    adapter,
  };
}
