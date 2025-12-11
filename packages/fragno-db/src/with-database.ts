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
  type ImplicitDatabaseBaseService,
  type FragnoPublicConfigWithDatabase,
  type DatabaseRequestStorage,
} from "./db-fragment-definition-builder";
import { internalFragmentDef, type InternalFragmentInstance } from "./fragments/internal-fragment";
import type { TypedUnitOfWork } from "./query/unit-of-work";
import type {
  ExecuteRestrictedUnitOfWorkOptions,
  AwaitedPromisesInObject,
} from "./query/execute-unit-of-work";

/**
 * Database fragment type that extends the base fragment with ImplicitDatabaseBaseService methods.
 * This adds the `uow` method directly on the fragment instance.
 */
export type DatabaseFragment<TFragment extends AnyFragnoInstantiatedFragment> = TFragment &
  ImplicitDatabaseBaseService;

/**
 * Wraps a database fragment to add the `uow` method directly on the fragment instance.
 * This eliminates the need for double callbacks (inContext + this.uow).
 *
 * @param fragment - The database fragment to enhance
 * @returns The same fragment with uow method added
 *
 * @example
 * ```typescript
 * const fragment = addDatabaseMethods(
 *   instantiate(myFragmentDef).withConfig({}).withOptions({ databaseAdapter }).build()
 * );
 *
 * // Now can call uow directly without inContext
 * const result = await fragment.uow(async ({ forSchema, executeRetrieve }) => {
 *   const uow = forSchema(schema);
 *   // ... use uow
 *   await executeRetrieve();
 *   return value;
 * });
 * ```
 */
export function addDatabaseMethods<TFragment extends AnyFragnoInstantiatedFragment>(
  fragment: TFragment,
): DatabaseFragment<TFragment> {
  const enhancedFragment = fragment as DatabaseFragment<TFragment>;

  // Add the uow method that wraps inContext + handler context uow
  enhancedFragment.uow = async function <TResult>(
    callback: (context: {
      forSchema: <S extends AnySchema>(schema: S) => TypedUnitOfWork<S, [], unknown>;
      executeRetrieve: () => Promise<void>;
      executeMutate: () => Promise<void>;
      nonce: string;
      currentAttempt: number;
    }) => Promise<TResult> | TResult,
    options?: Omit<ExecuteRestrictedUnitOfWorkOptions, "createUnitOfWork">,
  ): Promise<AwaitedPromisesInObject<TResult>> {
    return fragment.inContext(async function (this: DatabaseHandlerContext) {
      return await this.uow(callback, options);
    });
  };

  return enhancedFragment;
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
  namespace?: string,
): <
  TConfig,
  TDeps,
  TBaseServices,
  TServices extends Record<string, unknown>,
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
  TBaseServices & ImplicitDatabaseBaseService,
  TServices,
  TServiceDeps,
  TPrivateServices,
  DatabaseServiceContext,
  DatabaseHandlerContext,
  TLinkedFragments & { _fragno_internal: InternalFragmentInstance }
> {
  return <
    TConfig,
    TDeps,
    TBaseServices,
    TServices extends Record<string, unknown>,
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
      ({ config, options }) => {
        // Cast is safe: by the time this callback is invoked during fragment instantiation,
        // the options will be FragnoPublicConfigWithDatabase (enforced by DatabaseFragmentDefinitionBuilder)
        return instantiate(internalFragmentDef)
          .withConfig(config as {})
          .withOptions(options as FragnoPublicConfigWithDatabase)
          .build();
      },
    );

    // Cast is safe: we're creating a DatabaseFragmentDefinitionBuilder which internally uses
    // FragnoPublicConfigWithDatabase, but the input builder uses FragnoPublicConfig.
    // The database builder's build() method will enforce FragnoPublicConfigWithDatabase at the end.
    // We also add ImplicitDatabaseDependencies to TDeps so they're available in service constructors.
    // Note: We discard TRequestStorage here because database fragments manage their own storage (DatabaseRequestStorage).
    // We set TServiceThisContext to DatabaseServiceContext (restricted) and THandlerThisContext to DatabaseHandlerContext (full).
    const dbBuilder = new DatabaseFragmentDefinitionBuilder<
      TSchema,
      TConfig,
      TDeps & ImplicitDatabaseDependencies<TSchema>,
      TBaseServices & ImplicitDatabaseBaseService,
      TServices,
      TServiceDeps,
      TPrivateServices,
      DatabaseServiceContext,
      DatabaseHandlerContext,
      TLinkedFragments & { _fragno_internal: InternalFragmentInstance }
    >(
      builderWithInternal as unknown as FragmentDefinitionBuilder<
        TConfig,
        FragnoPublicConfigWithDatabase,
        TDeps & ImplicitDatabaseDependencies<TSchema>,
        TBaseServices & ImplicitDatabaseBaseService,
        TServices,
        TServiceDeps,
        TPrivateServices,
        DatabaseServiceContext,
        DatabaseHandlerContext,
        DatabaseRequestStorage,
        TLinkedFragments & { _fragno_internal: InternalFragmentInstance }
      >,
      schema,
      namespace,
    );

    return dbBuilder;
  };
}
