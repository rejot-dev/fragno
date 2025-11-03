import type { AnySchema } from "@fragno-dev/db/schema";
import {
  createFragmentForTest,
  type FragmentForTest,
  type CreateFragmentForTestOptions,
} from "@fragno-dev/core/test";
import type { FragnoPublicConfig } from "@fragno-dev/core/api/fragment-instantiation";
import type { FragmentDefinition } from "@fragno-dev/core/api/fragment-builder";
import type { AnyRouteOrFactory, FlattenRouteFactories } from "@fragno-dev/core/api/route";
import {
  createAdapter,
  type SupportedAdapter,
  type AdapterContext,
  type KyselySqliteAdapter,
  type KyselyPgliteAdapter,
  type DrizzlePgliteAdapter,
  type SchemaConfig,
} from "./adapters";
import { withUnitOfWork, type IUnitOfWorkBase, type DatabaseAdapter } from "@fragno-dev/db";
import type { AbstractQuery } from "@fragno-dev/db/query";

// Re-export utilities from @fragno-dev/core/test
export {
  createFragmentForTest,
  type CreateFragmentForTestOptions,
  type RouteHandlerInputOptions,
  type FragmentForTest,
} from "@fragno-dev/core/test";

// Re-export adapter types
export type {
  SupportedAdapter,
  KyselySqliteAdapter,
  KyselyPgliteAdapter,
  DrizzlePgliteAdapter,
  AdapterContext,
} from "./adapters";

/**
 * Base test context with common functionality across all adapters
 */
export interface BaseTestContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly adapter: DatabaseAdapter<any>;
  createUnitOfWork: (name?: string) => IUnitOfWorkBase;
  withUnitOfWork: <T>(fn: (uow: IUnitOfWorkBase) => Promise<T>) => Promise<T>;
  callService: <T>(fn: () => T | Promise<T>) => Promise<T>;
  resetDatabase: () => Promise<void>;
  cleanup: () => Promise<void>;
}

/**
 * Internal interface with getOrm for adapter implementations
 */
export interface InternalTestContextMethods {
  getOrm: <TSchema extends AnySchema>(namespace: string) => AbstractQuery<TSchema>;
  createUnitOfWork: (name?: string) => IUnitOfWorkBase;
  withUnitOfWork: <T>(fn: (uow: IUnitOfWorkBase) => Promise<T>) => Promise<T>;
  callService: <T>(fn: () => T | Promise<T>) => Promise<T>;
}

/**
 * Helper to create common test context methods from an ORM map
 * This is used internally by adapter implementations to avoid code duplication
 */
export function createCommonTestContextMethods(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ormMap: Map<string, AbstractQuery<any>>,
): InternalTestContextMethods {
  return {
    getOrm: <TSchema extends AnySchema>(namespace: string) => {
      const orm = ormMap.get(namespace);
      if (!orm) {
        throw new Error(`No ORM found for namespace: ${namespace}`);
      }
      return orm as AbstractQuery<TSchema>;
    },
    createUnitOfWork: (name?: string) => {
      // Use the first schema's ORM to create a base UOW
      const firstOrm = ormMap.values().next().value;
      if (!firstOrm) {
        throw new Error("No ORMs available to create UnitOfWork");
      }
      return firstOrm.createUnitOfWork(name);
    },
    withUnitOfWork: async <T>(fn: (uow: IUnitOfWorkBase) => Promise<T>) => {
      const firstOrm = ormMap.values().next().value;
      if (!firstOrm) {
        throw new Error("No ORMs available to create UnitOfWork");
      }
      const uow = firstOrm.createUnitOfWork();
      return withUnitOfWork(uow, async () => {
        return await fn(uow);
      });
    },
    callService: async <T>(fn: () => T | Promise<T>) => {
      const firstOrm = ormMap.values().next().value;
      if (!firstOrm) {
        throw new Error("No ORMs available to create UnitOfWork");
      }
      const uow = firstOrm.createUnitOfWork();
      return withUnitOfWork(uow, async () => {
        // Call the function to schedule operations (don't await yet)
        const resultPromise = fn();

        // Execute UOW phases
        await uow.executeRetrieve();
        await uow.executeMutations();

        // Now await the result
        return await resultPromise;
      });
    },
  };
}

/**
 * Complete test context combining base and adapter-specific functionality
 */
export type TestContext<T extends SupportedAdapter> = BaseTestContext & AdapterContext<T>;

/**
 * Helper type to extract the schema from a fragment definition's additional context
 */
type ExtractSchemaFromAdditionalContext<TAdditionalContext> = TAdditionalContext extends {
  databaseSchema?: infer TSchema extends AnySchema;
}
  ? TSchema
  : AnySchema;

/**
 * Fragment configuration for multi-fragment setup
 */
export interface FragmentConfig<
  TDef extends {
    definition: FragmentDefinition<any, any, any, any, any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    $requiredOptions: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  } = {
    definition: FragmentDefinition<any, any, any, any, any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    $requiredOptions: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  },
  TRoutes extends readonly AnyRouteOrFactory[] = readonly AnyRouteOrFactory[],
> {
  definition: TDef;
  routes: TRoutes;
  config?: TDef["definition"] extends FragmentDefinition<infer TConfig, any, any, any, any, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    ? TConfig
    : never;
  migrateToVersion?: number;
}

/**
 * Options for creating multiple database fragments for testing
 */
export interface MultiFragmentTestOptions<TAdapter extends SupportedAdapter> {
  adapter: TAdapter;
}

/**
 * Result type for a single fragment in a multi-fragment setup
 */
type FragmentResultFromConfig<TConfig extends FragmentConfig> = TConfig["definition"] extends {
  definition: FragmentDefinition<
    infer TConf,
    infer TDeps,
    infer TServices,
    infer TAdditionalCtx,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    infer TProvidedServices
  >;
  $requiredOptions: infer TOptions extends FragnoPublicConfig;
}
  ? {
      fragment: FragmentForTest<
        TConf,
        TDeps,
        TServices & TProvidedServices,
        TAdditionalCtx,
        TOptions,
        FlattenRouteFactories<TConfig["routes"]>
      >;
      services: TServices & TProvidedServices;
      callRoute: FragmentForTest<
        TConf,
        TDeps,
        TServices & TProvidedServices,
        TAdditionalCtx,
        TOptions,
        FlattenRouteFactories<TConfig["routes"]>
      >["callRoute"];
      config: TConf;
      deps: TDeps;
      additionalContext: TAdditionalCtx;
      db: AbstractQuery<ExtractSchemaFromAdditionalContext<TAdditionalCtx>>;
    }
  : never;

export interface SingleFragmentTestResult<
  TFragment extends FragmentConfig,
  TAdapter extends SupportedAdapter,
> {
  fragment: FragmentResultFromConfig<TFragment>;
  test: TestContext<TAdapter>;
}

/**
 * Result of creating multiple database fragments for testing (array input)
 */
export interface MultiFragmentTestResult<
  TFragments extends readonly FragmentConfig[],
  TAdapter extends SupportedAdapter,
> {
  fragments: {
    [K in keyof TFragments]: FragmentResultFromConfig<TFragments[K]>;
  };
  test: TestContext<TAdapter>;
}

/**
 * Result of creating multiple database fragments for testing (object input)
 */
export interface NamedMultiFragmentTestResult<
  TFragments extends Record<string, FragmentConfig>,
  TAdapter extends SupportedAdapter,
> {
  fragments: {
    [K in keyof TFragments]: FragmentResultFromConfig<TFragments[K]>;
  };
  test: TestContext<TAdapter>;
}

/**
 * Create multiple database fragments for testing with a shared adapter (array input)
 */
export async function createDatabaseFragmentsForTest<
  const TFragments extends readonly FragmentConfig[],
  const TAdapter extends SupportedAdapter,
>(
  fragments: TFragments,
  options: MultiFragmentTestOptions<TAdapter>,
): Promise<MultiFragmentTestResult<TFragments, TAdapter>>;

/**
 * Create multiple database fragments for testing with a shared adapter (object input)
 */
export async function createDatabaseFragmentsForTest<
  const TFragments extends Record<string, FragmentConfig>,
  const TAdapter extends SupportedAdapter,
>(
  fragments: TFragments,
  options: MultiFragmentTestOptions<TAdapter>,
): Promise<NamedMultiFragmentTestResult<TFragments, TAdapter>>;

/**
 * Implementation of createDatabaseFragmentsForTest
 */
export async function createDatabaseFragmentsForTest<
  const TFragments extends readonly FragmentConfig[] | Record<string, FragmentConfig>,
  const TAdapter extends SupportedAdapter,
>(
  fragments: TFragments,
  options: MultiFragmentTestOptions<TAdapter>,
): Promise<
  | MultiFragmentTestResult<any, TAdapter> // eslint-disable-line @typescript-eslint/no-explicit-any
  | NamedMultiFragmentTestResult<any, TAdapter> // eslint-disable-line @typescript-eslint/no-explicit-any
> {
  const { adapter: adapterConfig } = options;

  // Convert to array for processing
  const isArray = Array.isArray(fragments);
  const fragmentsArray: FragmentConfig[] = isArray
    ? fragments
    : Object.values(fragments as Record<string, FragmentConfig>);

  // Extract schemas from all fragments
  const schemaConfigs: SchemaConfig[] = fragmentsArray.map((fragmentConfig) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fragmentAdditionalContext = fragmentConfig.definition.definition.additionalContext as any;
    const schema = fragmentAdditionalContext?.databaseSchema as AnySchema | undefined;
    const namespace =
      (fragmentAdditionalContext?.databaseNamespace as string | undefined) ??
      fragmentConfig.definition.definition.name + "-db";

    if (!schema) {
      throw new Error(
        `Fragment '${fragmentConfig.definition.definition.name}' does not have a database schema. ` +
          `Make sure you're using defineFragmentWithDatabase().withDatabase(schema).`,
      );
    }

    return {
      schema,
      namespace,
      migrateToVersion: fragmentConfig.migrateToVersion,
    };
  });

  // Create adapter with all schemas
  const { testContext, adapter } = await createAdapter(adapterConfig, schemaConfigs);

  // Helper to create fragments with service wiring
  const createFragments = () => {
    // First pass: collect all provided services and wrap them
    // Map from service name to { service: wrapped service, orm: ORM for that service's schema }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const providedServicesByName: Record<string, { service: any; orm: any }> = {};

    for (let i = 0; i < fragmentsArray.length; i++) {
      const fragmentConfig = fragmentsArray[i]!;
      const providedServices = fragmentConfig.definition.definition.providedServices;
      if (providedServices) {
        const namespace = schemaConfigs[i]!.namespace;
        const orm = testContext.getOrm(namespace);

        // Collect each provided service
        for (const [serviceName, serviceImpl] of Object.entries(providedServices)) {
          if (serviceImpl && typeof serviceImpl === "object") {
            providedServicesByName[serviceName] = { service: serviceImpl, orm };
          }
        }
      }
    }

    // Second pass: create fragments with service dependencies wired up
    return fragmentsArray.map((fragmentConfig, index) => {
      const namespace = schemaConfigs[index]!.namespace;

      // Get ORM for this fragment's namespace
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const schema = schemaConfigs[index]!.schema as any;
      const orm = testContext.getOrm(namespace);

      // Create fragment with database adapter in options
      const mergedOptions = {
        databaseAdapter: adapter,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      // Build interface implementations for services this fragment uses
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const interfaceImplementations: Record<string, any> = {};
      const usedServices = fragmentConfig.definition.definition.usedServices;

      if (usedServices) {
        for (const serviceName of Object.keys(usedServices)) {
          if (providedServicesByName[serviceName]) {
            // Use the wrapped service
            interfaceImplementations[serviceName] = providedServicesByName[serviceName]!.service;
          }
        }
      }

      const fragment = createFragmentForTest(fragmentConfig.definition, fragmentConfig.routes, {
        config: fragmentConfig.config,
        options: mergedOptions,
        interfaceImplementations,
      });

      // Return fragment services without wrapping - users manage UOW lifecycle explicitly
      return {
        fragment,
        services: fragment.services,
        callRoute: fragment.callRoute,
        config: fragment.config,
        deps: fragment.deps,
        additionalContext: fragment.additionalContext,
        get db() {
          return orm;
        },
        _orm: orm,
        _schema: schema,
      };
    });
  };

  const fragmentResults = createFragments();

  // Wrap resetDatabase to also recreate all fragments
  const originalResetDatabase = testContext.resetDatabase;
  const resetDatabase = async () => {
    await originalResetDatabase();

    // Recreate all fragments with service wiring
    const newFragmentResults = createFragments();

    // Update the result objects
    newFragmentResults.forEach((newResult, index) => {
      const result = fragmentResults[index]!;
      result.fragment = newResult.fragment;
      result.services = newResult.services;
      result.callRoute = newResult.callRoute;
      result.config = newResult.config;
      result.deps = newResult.deps;
      result.additionalContext = newResult.additionalContext;
      result._orm = newResult._orm;
    });
  };

  const finalTestContext = {
    ...testContext,
    resetDatabase,
  };

  // Return in the same structure as input
  if (isArray) {
    return {
      fragments: fragmentResults as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      test: finalTestContext,
    };
  } else {
    const keys = Object.keys(fragments as Record<string, FragmentConfig>);
    const fragmentsObject = Object.fromEntries(
      keys.map((key, index) => [key, fragmentResults[index]]),
    );
    return {
      fragments: fragmentsObject as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      test: finalTestContext,
    };
  }
}

export async function createDatabaseFragmentForTest<
  const TFragment extends FragmentConfig,
  const TAdapter extends SupportedAdapter,
>(
  fragment: TFragment,
  options: MultiFragmentTestOptions<TAdapter>,
): Promise<SingleFragmentTestResult<TFragment, TAdapter>> {
  const result = await createDatabaseFragmentsForTest([fragment], options);

  return {
    fragment: result.fragments[0]!,
    test: result.test,
  };
}
