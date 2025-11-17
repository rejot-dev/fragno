import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { FragnoRouteConfig, HTTPMethod, RequestThisContext } from "./api";
import type { NewFragmentDefinition } from "./fragment-definition-builder";
import type { BoundServices } from "./bind-services";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyFragnoRouteConfig = FragnoRouteConfig<HTTPMethod, string, any, any, any, any, any>;

export type AnyFragmentBuilder = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly definition: NewFragmentDefinition<any, any, any, any, any, any, any, any>;
};

export interface RouteFactoryContext<TConfig, TDeps, TServices, TServiceDeps = {}> {
  config: TConfig;
  deps: TDeps;
  services: TServices;
  serviceDeps: TServiceDeps;
}

export type RouteFactory<
  TConfig,
  TDeps,
  TServices,
  TServiceDeps,
  TRoutes extends readonly FragnoRouteConfig<
    HTTPMethod,
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    string,
    string,
    RequestThisContext
  >[],
> = (context: RouteFactoryContext<TConfig, TDeps, TServices, TServiceDeps>) => TRoutes;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRouteOrFactory = AnyFragnoRouteConfig | RouteFactory<any, any, any, any, any>;

export type FlattenRouteFactories<T extends readonly AnyRouteOrFactory[]> = T extends readonly [
  infer First,
  ...infer Rest extends readonly AnyRouteOrFactory[],
]
  ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
    First extends RouteFactory<any, any, any, any, infer TRoutes>
    ? [...TRoutes, ...FlattenRouteFactories<Rest>]
    : [First, ...FlattenRouteFactories<Rest>]
  : [];

// Helper to resolve route factories into routes
export function resolveRouteFactories<
  TConfig,
  TDeps,
  TServices,
  TServiceDeps,
  const TRoutesOrFactories extends readonly AnyRouteOrFactory[],
>(
  context: RouteFactoryContext<TConfig, TDeps, TServices, TServiceDeps>,
  routesOrFactories: TRoutesOrFactories,
): FlattenRouteFactories<TRoutesOrFactories> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const routes: any[] = [];

  for (const item of routesOrFactories) {
    if (typeof item === "function") {
      // It's a route factory
      const factoryRoutes = item(context);
      routes.push(...factoryRoutes);
    } else {
      // It's a direct route
      routes.push(item);
    }
  }

  return routes as FlattenRouteFactories<TRoutesOrFactories>;
}

// TODO(Wilco): Do these overloads actually do anything?
// TODO(Wilco): ValidPath<T> should be added back in here.

// Overload for routes without inputSchema
export function defineRoute<
  const TMethod extends HTTPMethod,
  const TPath extends string,
  const TOutputSchema extends StandardSchemaV1 | undefined,
  const TErrorCode extends string = string,
  const TQueryParameters extends string = string,
  const TThisContext extends RequestThisContext = RequestThisContext,
>(
  config: FragnoRouteConfig<
    TMethod,
    TPath,
    undefined,
    TOutputSchema,
    TErrorCode,
    TQueryParameters,
    TThisContext
  > & { inputSchema?: undefined },
): FragnoRouteConfig<
  TMethod,
  TPath,
  undefined,
  TOutputSchema,
  TErrorCode,
  TQueryParameters,
  TThisContext
>;

// Overload for routes with inputSchema
export function defineRoute<
  const TMethod extends HTTPMethod,
  const TPath extends string,
  const TInputSchema extends StandardSchemaV1,
  const TOutputSchema extends StandardSchemaV1 | undefined,
  const TErrorCode extends string = string,
  const TQueryParameters extends string = string,
  const TThisContext extends RequestThisContext = RequestThisContext,
>(
  config: FragnoRouteConfig<
    TMethod,
    TPath,
    TInputSchema,
    TOutputSchema,
    TErrorCode,
    TQueryParameters,
    TThisContext
  > & { inputSchema: TInputSchema },
): FragnoRouteConfig<
  TMethod,
  TPath,
  TInputSchema,
  TOutputSchema,
  TErrorCode,
  TQueryParameters,
  TThisContext
>;

// implementation
export function defineRoute<
  const TMethod extends HTTPMethod,
  const TPath extends string,
  const TInputSchema extends StandardSchemaV1 | undefined,
  const TOutputSchema extends StandardSchemaV1 | undefined,
  const TErrorCode extends string = string,
  const TQueryParameters extends string = string,
  const TThisContext extends RequestThisContext = RequestThisContext,
>(
  config: FragnoRouteConfig<
    TMethod,
    TPath,
    TInputSchema,
    TOutputSchema,
    TErrorCode,
    TQueryParameters,
    TThisContext
  >,
): FragnoRouteConfig<
  TMethod,
  TPath,
  TInputSchema,
  TOutputSchema,
  TErrorCode,
  TQueryParameters,
  TThisContext
> {
  return config;
}

// Type helpers to extract types from FragmentBuilder or DatabaseFragmentBuilder
// DatabaseFragmentBuilder has 6 type parameters: TSchema, TConfig, TDeps, TServices, TUsedServices, TProvidedServices
// FragmentBuilder has 6 type parameters: TConfig, TDeps, TServices, TAdditionalContext, TUsedServices, TProvidedServices

// Helper to get the return type of the definition getter
// Use T['definition'] to access the property type
type GetDefinition<T> = T extends { definition: unknown } ? T["definition"] : never;

// Extract config - deprecated, use ExtractNewFragmentConfig instead
export type ExtractFragmentConfig<T> = ExtractNewFragmentConfig<GetDefinition<T>>;

// Extract deps - deprecated, use ExtractNewFragmentDeps instead
export type ExtractFragmentDeps<T> = ExtractNewFragmentDeps<GetDefinition<T>>;

// Extract services - deprecated, use ExtractNewFragmentServices instead
export type ExtractFragmentServices<T> = ExtractNewFragmentServices<GetDefinition<T>>;

// Extract the this context type from the fragment builder - deprecated, use ExtractNewFragmentThisContext instead
export type ExtractThisContext<T> = ExtractNewFragmentThisContext<GetDefinition<T>>;

// ============================================================================
// Type extractors for NewFragmentDefinition
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyNewFragmentDefinition = NewFragmentDefinition<
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any, // eslint-disable-line @typescript-eslint/no-explicit-any
  any // eslint-disable-line @typescript-eslint/no-explicit-any
>;

// Extract config from NewFragmentDefinition
export type ExtractNewFragmentConfig<T> =
  T extends NewFragmentDefinition<
    infer TConfig,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any
  >
    ? TConfig
    : never;

// Extract deps from NewFragmentDefinition
export type ExtractNewFragmentDeps<T> =
  T extends NewFragmentDefinition<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    infer TDeps,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any
  >
    ? TDeps
    : never;

// Extract services from NewFragmentDefinition
// This extracts both base services (flat) and named services (nested)
// The result matches the structure of fragment.services at runtime
export type ExtractNewFragmentServices<T> =
  T extends NewFragmentDefinition<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    infer TBaseServices,
    infer TServices,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any
  >
    ? BoundServices<TBaseServices & TServices>
    : never;

// Extract service dependencies from NewFragmentDefinition
export type ExtractNewFragmentServiceDeps<T> =
  T extends NewFragmentDefinition<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    infer TServiceDependencies,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any
  >
    ? TServiceDependencies
    : never;

// Extract this context from NewFragmentDefinition
export type ExtractNewFragmentThisContext<T> =
  T extends NewFragmentDefinition<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    infer TThisContext,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any
  >
    ? TThisContext
    : RequestThisContext;

// Old defineRoutes - DEPRECATED, use defineRoutesNew instead
// Kept for backwards compatibility during migration
/** @deprecated Use defineRoutesNew instead */
export const defineRoutes = defineRoutesNew;

// ============================================================================
// defineRoutesNew - for NewFragmentDefinition
// ============================================================================

// Overload that infers types from NewFragmentDefinition (runtime value)
export function defineRoutesNew<const TDefinition extends AnyNewFragmentDefinition>(
  definition: TDefinition,
): {
  create: <
    const TRoutes extends readonly FragnoRouteConfig<
      HTTPMethod,
      string,
      StandardSchemaV1 | undefined,
      StandardSchemaV1 | undefined,
      string,
      string,
      ExtractNewFragmentThisContext<TDefinition>
    >[],
  >(
    fn: (
      context: RouteFactoryContext<
        ExtractNewFragmentConfig<TDefinition>,
        ExtractNewFragmentDeps<TDefinition>,
        ExtractNewFragmentServices<TDefinition>,
        ExtractNewFragmentServiceDeps<TDefinition>
      > & {
        defineRoute: <
          const TMethod extends HTTPMethod,
          const TPath extends string,
          const TInputSchema extends StandardSchemaV1 | undefined,
          const TOutputSchema extends StandardSchemaV1 | undefined,
          const TErrorCode extends string = string,
          const TQueryParameters extends string = string,
        >(
          config: FragnoRouteConfig<
            TMethod,
            TPath,
            TInputSchema,
            TOutputSchema,
            TErrorCode,
            TQueryParameters,
            ExtractNewFragmentThisContext<TDefinition>
          >,
        ) => FragnoRouteConfig<
          TMethod,
          TPath,
          TInputSchema,
          TOutputSchema,
          TErrorCode,
          TQueryParameters,
          ExtractNewFragmentThisContext<TDefinition>
        >;
      },
    ) => TRoutes,
  ) => RouteFactory<
    ExtractNewFragmentConfig<TDefinition>,
    ExtractNewFragmentDeps<TDefinition>,
    ExtractNewFragmentServices<TDefinition>,
    ExtractNewFragmentServiceDeps<TDefinition>,
    TRoutes
  >;
};

// Overload that infers types from NewFragmentDefinition (type parameter only)
export function defineRoutesNew<const TDefinition extends AnyNewFragmentDefinition>(): {
  create: <
    const TRoutes extends readonly FragnoRouteConfig<
      HTTPMethod,
      string,
      StandardSchemaV1 | undefined,
      StandardSchemaV1 | undefined,
      string,
      string,
      ExtractNewFragmentThisContext<TDefinition>
    >[],
  >(
    fn: (
      context: RouteFactoryContext<
        ExtractNewFragmentConfig<TDefinition>,
        ExtractNewFragmentDeps<TDefinition>,
        ExtractNewFragmentServices<TDefinition>,
        ExtractNewFragmentServiceDeps<TDefinition>
      > & {
        defineRoute: <
          const TMethod extends HTTPMethod,
          const TPath extends string,
          const TInputSchema extends StandardSchemaV1 | undefined,
          const TOutputSchema extends StandardSchemaV1 | undefined,
          const TErrorCode extends string = string,
          const TQueryParameters extends string = string,
        >(
          config: FragnoRouteConfig<
            TMethod,
            TPath,
            TInputSchema,
            TOutputSchema,
            TErrorCode,
            TQueryParameters,
            ExtractNewFragmentThisContext<TDefinition>
          >,
        ) => FragnoRouteConfig<
          TMethod,
          TPath,
          TInputSchema,
          TOutputSchema,
          TErrorCode,
          TQueryParameters,
          ExtractNewFragmentThisContext<TDefinition>
        >;
      },
    ) => TRoutes,
  ) => RouteFactory<
    ExtractNewFragmentConfig<TDefinition>,
    ExtractNewFragmentDeps<TDefinition>,
    ExtractNewFragmentServices<TDefinition>,
    ExtractNewFragmentServiceDeps<TDefinition>,
    TRoutes
  >;
};

// Implementation
export function defineRoutesNew<
  const TDefinition extends AnyNewFragmentDefinition | undefined = undefined,
>(
  // Parameter is only used for type inference, not runtime
  _definition?: TDefinition,
) {
  return {
    create: <
      const TRoutes extends readonly FragnoRouteConfig<
        HTTPMethod,
        string,
        StandardSchemaV1 | undefined,
        StandardSchemaV1 | undefined,
        string,
        string,
        TDefinition extends AnyNewFragmentDefinition
          ? ExtractNewFragmentThisContext<TDefinition>
          : RequestThisContext
      >[],
    >(
      fn: (
        context: RouteFactoryContext<
          TDefinition extends AnyNewFragmentDefinition ? ExtractNewFragmentConfig<TDefinition> : {},
          TDefinition extends AnyNewFragmentDefinition ? ExtractNewFragmentDeps<TDefinition> : {},
          TDefinition extends AnyNewFragmentDefinition
            ? ExtractNewFragmentServices<TDefinition>
            : {},
          TDefinition extends AnyNewFragmentDefinition
            ? ExtractNewFragmentServiceDeps<TDefinition>
            : {}
        > & {
          defineRoute: <
            const TMethod extends HTTPMethod,
            const TPath extends string,
            const TInputSchema extends StandardSchemaV1 | undefined,
            const TOutputSchema extends StandardSchemaV1 | undefined,
            const TErrorCode extends string = string,
            const TQueryParameters extends string = string,
          >(
            config: FragnoRouteConfig<
              TMethod,
              TPath,
              TInputSchema,
              TOutputSchema,
              TErrorCode,
              TQueryParameters,
              TDefinition extends AnyNewFragmentDefinition
                ? ExtractNewFragmentThisContext<TDefinition>
                : RequestThisContext
            >,
          ) => FragnoRouteConfig<
            TMethod,
            TPath,
            TInputSchema,
            TOutputSchema,
            TErrorCode,
            TQueryParameters,
            TDefinition extends AnyNewFragmentDefinition
              ? ExtractNewFragmentThisContext<TDefinition>
              : RequestThisContext
          >;
        },
      ) => TRoutes,
    ): RouteFactory<
      TDefinition extends AnyNewFragmentDefinition ? ExtractNewFragmentConfig<TDefinition> : {},
      TDefinition extends AnyNewFragmentDefinition ? ExtractNewFragmentDeps<TDefinition> : {},
      TDefinition extends AnyNewFragmentDefinition ? ExtractNewFragmentServices<TDefinition> : {},
      TDefinition extends AnyNewFragmentDefinition
        ? ExtractNewFragmentServiceDeps<TDefinition>
        : {},
      TRoutes
    > => {
      // Create a wrapper around the callback that adds the defineRoute function
      return (ctx: RouteFactoryContext<unknown, unknown, unknown, unknown>) => {
        const extendedCtx = {
          ...ctx,
          defineRoute,
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return fn(extendedCtx as any);
      };
    },
  };
}
