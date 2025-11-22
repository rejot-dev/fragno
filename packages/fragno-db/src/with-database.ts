import type { AnySchema } from "./schema/create";
import type { RequestThisContext, FragnoPublicConfig } from "@fragno-dev/core";
import { FragmentDefinitionBuilder, instantiate } from "@fragno-dev/core";
import {
  DatabaseFragmentDefinitionBuilder,
  type DatabaseServiceContext,
  type DatabaseHandlerContext,
  type ImplicitDatabaseDependencies,
  type FragnoPublicConfigWithDatabase,
  type DatabaseRequestStorage,
} from "./db-fragment-definition-builder";
import { internalFragmentDef } from "./fragments/internal-fragment";

/**
 * Helper to add database support to a fragment builder.
 * Automatically links the internal fragment and adds ImplicitDatabaseDependencies to the TDeps type.
 *
 * @example
 * ```typescript
 * // With .extend() - recommended
 * const def = defineFragment("my-frag")
 *   .extend(withDatabase(mySchema))
 *   .withDependencies(...)
 *   .build();
 *
 * // Or as a function wrapper
 * const def = withDatabase(mySchema)(defineFragment("my-frag"))
 *   .withDependencies(...)
 *   .build();
 * ```
 */
export function withDatabase<TSchema extends AnySchema>(
  schema: TSchema,
  namespace?: string,
): <
  TConfig,
  TDeps,
  TBaseServices,
  TServices,
  TServiceDeps,
  TPrivateServices,
  TServiceThisContext extends RequestThisContext,
  THandlerThisContext extends RequestThisContext,
  TRequestStorage,
>(
  builder: FragmentDefinitionBuilder<
    TConfig,
    FragnoPublicConfig,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDeps,
    TPrivateServices,
    TServiceThisContext,
    THandlerThisContext,
    TRequestStorage
  >,
) => DatabaseFragmentDefinitionBuilder<
  TSchema,
  TConfig,
  TDeps & ImplicitDatabaseDependencies<TSchema>,
  TBaseServices,
  TServices,
  TServiceDeps,
  TPrivateServices,
  DatabaseServiceContext,
  DatabaseHandlerContext
> {
  return <
    TConfig,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDeps,
    TPrivateServices,
    TServiceThisContext extends RequestThisContext,
    THandlerThisContext extends RequestThisContext,
    TRequestStorage,
  >(
    builder: FragmentDefinitionBuilder<
      TConfig,
      FragnoPublicConfig,
      TDeps,
      TBaseServices,
      TServices,
      TServiceDeps,
      TPrivateServices,
      TServiceThisContext,
      THandlerThisContext,
      TRequestStorage
    >,
  ) => {
    // Link the internal fragment to all database fragments (except the internal fragment itself)
    // No circular dependency: internal-fragment.ts uses DatabaseFragmentDefinitionBuilder directly
    const isInternalFragment = builder.name === "$fragno-internal-fragment";
    const builderWithInternal = isInternalFragment
      ? builder
      : builder.withLinkedFragment("_fragno_internal", ({ config, options }) => {
          // Cast is safe: by the time this callback is invoked during fragment instantiation,
          // the options will be FragnoPublicConfigWithDatabase (enforced by DatabaseFragmentDefinitionBuilder)
          return instantiate(internalFragmentDef)
            .withConfig(config as {})
            .withOptions(options as FragnoPublicConfigWithDatabase)
            .build();
        });

    // Cast is safe: we're creating a DatabaseFragmentDefinitionBuilder which internally uses
    // FragnoPublicConfigWithDatabase, but the input builder uses FragnoPublicConfig.
    // The database builder's build() method will enforce FragnoPublicConfigWithDatabase at the end.
    // We also add ImplicitDatabaseDependencies to TDeps so they're available in service constructors.
    // Note: We discard TRequestStorage here because database fragments manage their own storage (DatabaseRequestStorage).
    // We set TServiceThisContext to DatabaseServiceContext (restricted) and THandlerThisContext to DatabaseHandlerContext (full).
    return new DatabaseFragmentDefinitionBuilder<
      TSchema,
      TConfig,
      TDeps & ImplicitDatabaseDependencies<TSchema>,
      TBaseServices,
      TServices,
      TServiceDeps,
      TPrivateServices,
      DatabaseServiceContext,
      DatabaseHandlerContext
    >(
      builderWithInternal as unknown as FragmentDefinitionBuilder<
        TConfig,
        FragnoPublicConfigWithDatabase,
        TDeps & ImplicitDatabaseDependencies<TSchema>,
        TBaseServices,
        TServices,
        TServiceDeps,
        TPrivateServices,
        DatabaseServiceContext,
        DatabaseHandlerContext,
        DatabaseRequestStorage
      >,
      schema,
      namespace,
    );
  };
}
