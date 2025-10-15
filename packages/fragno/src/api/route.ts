import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { FragnoRouteConfig, HTTPMethod } from "./api";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyFragnoRouteConfig = FragnoRouteConfig<HTTPMethod, string, any, any, any, any>;

export interface RouteFactoryContext<TConfig, TDeps, TServices> {
  config: TConfig;
  deps: TDeps;
  services: TServices;
}

export type RouteFactory<
  TConfig,
  TDeps,
  TServices,
  TRoutes extends readonly FragnoRouteConfig<
    HTTPMethod,
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    string,
    string
  >[],
> = (context: RouteFactoryContext<TConfig, TDeps, TServices>) => TRoutes;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRouteOrFactory = AnyFragnoRouteConfig | RouteFactory<any, any, any, any>;

export type FlattenRouteFactories<T extends readonly AnyRouteOrFactory[]> = T extends readonly [
  infer First,
  ...infer Rest extends readonly AnyRouteOrFactory[],
]
  ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
    First extends RouteFactory<any, any, any, infer TRoutes>
    ? [...TRoutes, ...FlattenRouteFactories<Rest>]
    : [First, ...FlattenRouteFactories<Rest>]
  : [];

// Helper to resolve route factories into routes
export function resolveRouteFactories<
  TConfig,
  TDeps,
  TServices,
  const TRoutesOrFactories extends readonly AnyRouteOrFactory[],
>(
  context: RouteFactoryContext<TConfig, TDeps, TServices>,
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
>(
  config: FragnoRouteConfig<
    TMethod,
    TPath,
    undefined,
    TOutputSchema,
    TErrorCode,
    TQueryParameters
  > & { inputSchema?: undefined },
): FragnoRouteConfig<TMethod, TPath, undefined, TOutputSchema, TErrorCode, TQueryParameters>;

// Overload for routes with inputSchema
export function defineRoute<
  const TMethod extends HTTPMethod,
  const TPath extends string,
  const TInputSchema extends StandardSchemaV1,
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
    TQueryParameters
  > & { inputSchema: TInputSchema },
): FragnoRouteConfig<TMethod, TPath, TInputSchema, TOutputSchema, TErrorCode, TQueryParameters>;

// implementation
export function defineRoute<
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
    TQueryParameters
  >,
): FragnoRouteConfig<TMethod, TPath, TInputSchema, TOutputSchema, TErrorCode, TQueryParameters> {
  return config;
}

export function defineRoutes<TConfig = {}, TDeps = {}, TServices = {}>() {
  return {
    create: <
      const TRoutes extends readonly FragnoRouteConfig<
        HTTPMethod,
        string,
        StandardSchemaV1 | undefined,
        StandardSchemaV1 | undefined,
        string,
        string
      >[],
    >(
      fn: (context: RouteFactoryContext<TConfig, TDeps, TServices>) => TRoutes,
    ): RouteFactory<TConfig, TDeps, TServices, TRoutes> => {
      return fn;
    },
  };
}
