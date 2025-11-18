// oxlint-disable no-explicit-any

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { FragnoRouteConfig, HTTPMethod, RequestThisContext } from "./api";
import type { FragmentDefinition } from "./fragment-definition-builder";
import type { BoundServices } from "./bind-services";

export type AnyFragnoRouteConfig = FragnoRouteConfig<HTTPMethod, string, any, any, any, any, any>;

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

/**
 * @internal
 */
export type AnyRouteOrFactory = AnyFragnoRouteConfig | RouteFactory<any, any, any, any, any>;

/**
 * @internal
 */
export type FlattenRouteFactories<T extends readonly AnyRouteOrFactory[]> = T extends readonly [
  infer First,
  ...infer Rest extends readonly AnyRouteOrFactory[],
]
  ? First extends RouteFactory<any, any, any, any, infer TRoutes>
    ? [...TRoutes, ...FlattenRouteFactories<Rest>]
    : [First, ...FlattenRouteFactories<Rest>]
  : [];

/**
 * Helper to resolve route factories into routes
 * @internal
 */
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

// ============================================================================
// Type extractors for FragmentDefinition
// ============================================================================

export type AnyFragmentDefinition = FragmentDefinition<any, any, any, any, any, any, any, any>;

// Extract config from FragmentDefinition
export type ExtractFragmentConfig<T> =
  T extends FragmentDefinition<infer TConfig, any, any, any, any, any, any, any> ? TConfig : never;

// Extract deps from FragmentDefinition
export type ExtractFragmentDeps<T> =
  T extends FragmentDefinition<any, any, infer TDeps, any, any, any, any, any> ? TDeps : never;

// Extract services from FragmentDefinition
// This extracts both base services (flat) and named services (nested)
// The result matches the structure of fragment.services at runtime
export type ExtractFragmentServices<T> =
  T extends FragmentDefinition<any, any, any, infer TBaseServices, infer TServices, any, any, any>
    ? BoundServices<TBaseServices & TServices>
    : never;

// Extract service dependencies from FragmentDefinition
export type ExtractFragmentServiceDeps<T> =
  T extends FragmentDefinition<any, any, any, any, any, infer TServiceDependencies, any, any>
    ? TServiceDependencies
    : never;

// Extract this context from FragmentDefinition
export type ExtractFragmentThisContext<T> =
  T extends FragmentDefinition<any, any, any, any, any, any, infer TThisContext, any>
    ? TThisContext
    : RequestThisContext;

// Overload that infers types from FragmentDefinition (runtime value)
export function defineRoutes<const TDefinition extends AnyFragmentDefinition>(
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
      ExtractFragmentThisContext<TDefinition>
    >[],
  >(
    fn: (
      context: RouteFactoryContext<
        ExtractFragmentConfig<TDefinition>,
        ExtractFragmentDeps<TDefinition>,
        ExtractFragmentServices<TDefinition>,
        ExtractFragmentServiceDeps<TDefinition>
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
            ExtractFragmentThisContext<TDefinition>
          >,
        ) => FragnoRouteConfig<
          TMethod,
          TPath,
          TInputSchema,
          TOutputSchema,
          TErrorCode,
          TQueryParameters,
          ExtractFragmentThisContext<TDefinition>
        >;
      },
    ) => TRoutes,
  ) => RouteFactory<
    ExtractFragmentConfig<TDefinition>,
    ExtractFragmentDeps<TDefinition>,
    ExtractFragmentServices<TDefinition>,
    ExtractFragmentServiceDeps<TDefinition>,
    TRoutes
  >;
};

// Overload that infers types from FragmentDefinition (type parameter only)
export function defineRoutes<const TDefinition extends AnyFragmentDefinition>(): {
  create: <
    const TRoutes extends readonly FragnoRouteConfig<
      HTTPMethod,
      string,
      StandardSchemaV1 | undefined,
      StandardSchemaV1 | undefined,
      string,
      string,
      ExtractFragmentThisContext<TDefinition>
    >[],
  >(
    fn: (
      context: RouteFactoryContext<
        ExtractFragmentConfig<TDefinition>,
        ExtractFragmentDeps<TDefinition>,
        ExtractFragmentServices<TDefinition>,
        ExtractFragmentServiceDeps<TDefinition>
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
            ExtractFragmentThisContext<TDefinition>
          >,
        ) => FragnoRouteConfig<
          TMethod,
          TPath,
          TInputSchema,
          TOutputSchema,
          TErrorCode,
          TQueryParameters,
          ExtractFragmentThisContext<TDefinition>
        >;
      },
    ) => TRoutes,
  ) => RouteFactory<
    ExtractFragmentConfig<TDefinition>,
    ExtractFragmentDeps<TDefinition>,
    ExtractFragmentServices<TDefinition>,
    ExtractFragmentServiceDeps<TDefinition>,
    TRoutes
  >;
};

// Implementation
export function defineRoutes<
  const TDefinition extends AnyFragmentDefinition | undefined = undefined,
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
        TDefinition extends AnyFragmentDefinition
          ? ExtractFragmentThisContext<TDefinition>
          : RequestThisContext
      >[],
    >(
      fn: (
        context: RouteFactoryContext<
          TDefinition extends AnyFragmentDefinition ? ExtractFragmentConfig<TDefinition> : {},
          TDefinition extends AnyFragmentDefinition ? ExtractFragmentDeps<TDefinition> : {},
          TDefinition extends AnyFragmentDefinition ? ExtractFragmentServices<TDefinition> : {},
          TDefinition extends AnyFragmentDefinition ? ExtractFragmentServiceDeps<TDefinition> : {}
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
              TDefinition extends AnyFragmentDefinition
                ? ExtractFragmentThisContext<TDefinition>
                : RequestThisContext
            >,
          ) => FragnoRouteConfig<
            TMethod,
            TPath,
            TInputSchema,
            TOutputSchema,
            TErrorCode,
            TQueryParameters,
            TDefinition extends AnyFragmentDefinition
              ? ExtractFragmentThisContext<TDefinition>
              : RequestThisContext
          >;
        },
      ) => TRoutes,
    ): RouteFactory<
      TDefinition extends AnyFragmentDefinition ? ExtractFragmentConfig<TDefinition> : {},
      TDefinition extends AnyFragmentDefinition ? ExtractFragmentDeps<TDefinition> : {},
      TDefinition extends AnyFragmentDefinition ? ExtractFragmentServices<TDefinition> : {},
      TDefinition extends AnyFragmentDefinition ? ExtractFragmentServiceDeps<TDefinition> : {},
      TRoutes
    > => {
      // Create a wrapper around the callback that adds the defineRoute function
      return (ctx: RouteFactoryContext<unknown, unknown, unknown, unknown>) => {
        const extendedCtx = {
          ...ctx,
          defineRoute,
        };
        return fn(extendedCtx as any);
      };
    },
  };
}
