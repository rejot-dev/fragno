import type { AnySchema } from "./schema/create";
import type {
  RequestThisContext,
  FragnoPublicConfig,
  AnyFragnoInstantiatedFragment,
} from "@fragno-dev/core";
import { FragmentDefinitionBuilder } from "@fragno-dev/core";
import {
  DatabaseFragmentDefinitionBuilder,
  type DatabaseServiceContext,
  type DatabaseHandlerContext,
  type ImplicitDatabaseDependencies,
  type FragnoPublicConfigWithDatabase,
  type DatabaseRequestStorage,
} from "./db-fragment-definition-builder";
import type { HooksMap } from "./hooks/hooks";
import { getInternalFragment, getRegistryForAdapterSync } from "./internal/adapter-registry";

/**
 * Helper to add database support to a fragment builder.
 * Registers the schema with the adapter registry and adds ImplicitDatabaseDependencies to the TDeps type.
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
  TLinkedFragments extends Record<string, AnyFragnoInstantiatedFragment>,
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
    TRequestStorage,
    TLinkedFragments
  >,
) => DatabaseFragmentDefinitionBuilder<
  TSchema,
  TConfig,
  TDeps & ImplicitDatabaseDependencies<TSchema>,
  TBaseServices,
  TServices,
  TServiceDeps,
  TPrivateServices,
  HooksMap,
  DatabaseServiceContext<HooksMap>,
  DatabaseHandlerContext,
  TLinkedFragments
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
    TLinkedFragments extends Record<string, AnyFragnoInstantiatedFragment>,
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
      TRequestStorage,
      TLinkedFragments
    >,
  ) => {
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
      {}, // Start with empty hooks, provideHooks() will update this
      DatabaseServiceContext<{}>,
      DatabaseHandlerContext,
      TLinkedFragments
    >(
      builder as unknown as FragmentDefinitionBuilder<
        TConfig,
        FragnoPublicConfigWithDatabase,
        TDeps & ImplicitDatabaseDependencies<TSchema>,
        TBaseServices,
        TServices,
        TServiceDeps,
        TPrivateServices,
        DatabaseServiceContext<{}>,
        DatabaseHandlerContext,
        DatabaseRequestStorage,
        TLinkedFragments
      >,
      schema,
      undefined,
      {
        getRegistryForAdapterSync,
        getInternalFragment,
      },
    );
  };
}
