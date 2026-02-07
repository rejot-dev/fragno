import type { AnySchema } from "./schema/create";
import type {
  RequestThisContext,
  FragnoPublicConfig,
  AnyFragnoInstantiatedFragment,
} from "@fragno-dev/core";
import { FragmentDefinitionBuilder, instantiate } from "@fragno-dev/core";
import {
  DatabaseFragmentDefinitionBuilder,
  type DatabaseServiceContext,
  type DatabaseHandlerContext,
  type ImplicitDatabaseDependencies,
  type FragnoPublicConfigWithDatabase,
  type DatabaseRequestStorage,
} from "./db-fragment-definition-builder";
import { internalFragmentDef, type InternalFragmentInstance } from "./fragments/internal-fragment";
import {
  internalFragmentDescribeRoutes,
  internalFragmentOutboxRoutes,
} from "./fragments/internal-fragment.routes";
import type { HooksMap } from "./hooks/hooks";
import { resolveDatabaseAdapter } from "./util/default-database-adapter";

function shouldExposeOutboxRoutes(
  options: FragnoPublicConfigWithDatabase,
  schema: AnySchema,
): boolean {
  const adapter = resolveDatabaseAdapter(options, schema) as { outbox?: { enabled?: boolean } };
  return adapter.outbox?.enabled ?? false;
}

function resolveDatabaseNamespace(
  options: FragnoPublicConfigWithDatabase,
  schema: AnySchema,
): string | null {
  const hasOverride = options.databaseNamespace !== undefined;
  return hasOverride ? (options.databaseNamespace ?? null) : schema.name;
}

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
  TLinkedFragments & { _fragno_internal: InternalFragmentInstance }
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
    const builderWithInternal = builder.withLinkedFragment(
      "_fragno_internal",
      ({ options, parent }) => {
        const outboxEnabled = shouldExposeOutboxRoutes(
          options as FragnoPublicConfigWithDatabase,
          schema,
        );
        const internalRoutes = [
          internalFragmentDescribeRoutes,
          ...(outboxEnabled ? [internalFragmentOutboxRoutes] : []),
        ];
        const namespace = resolveDatabaseNamespace(
          options as FragnoPublicConfigWithDatabase,
          schema,
        );
        const schemaInfo = {
          name: schema.name,
          namespace,
          version: schema.version,
          tables: Object.keys(schema.tables).sort(),
        };

        // Cast is safe: by the time this callback is invoked during fragment instantiation,
        // the options will be FragnoPublicConfigWithDatabase (enforced by DatabaseFragmentDefinitionBuilder)
        return instantiate(internalFragmentDef)
          .withConfig({
            parent,
            schemas: [schemaInfo],
            outbox: { enabled: outboxEnabled },
          })
          .withOptions({
            ...(options as FragnoPublicConfigWithDatabase),
            databaseNamespace: null,
          })
          .withRoutes(internalRoutes)
          .build();
      },
    );

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
      TLinkedFragments & { _fragno_internal: InternalFragmentInstance }
    >(
      builderWithInternal as unknown as FragmentDefinitionBuilder<
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
        TLinkedFragments & { _fragno_internal: InternalFragmentInstance }
      >,
      schema,
    );
  };
}
