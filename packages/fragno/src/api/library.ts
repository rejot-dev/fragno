import type { StandardSchemaV1 } from "@standard-schema/spec";
import { type FragnoRouteConfig, type HTTPMethod } from "./api";
import { FragnoApiError } from "./error";
import { getMountRoute } from "./internal/route";
import { addRoute, createRouter, findRoute } from "rou3";
import { RequestInputContext } from "./request-input-context";
import type { ExtractPathParams } from "./internal/path";
import { RequestOutputContext } from "./request-output-context";
import {
  type EmptyObject,
  type AnyFragnoRouteConfig,
  type AnyRouteOrFactory,
  type FlattenRouteFactories,
  resolveRouteFactories,
} from "./route";
import { RequestMiddlewareContext, type FragnoMiddlewareCallback } from "./request-middleware";

export interface FragnoPublicConfig {
  mountRoute?: string;
}

export interface FragnoPublicClientConfig {
  mountRoute?: string;
  baseUrl?: string;
}

export interface FragnoInstantiatedLibrary<
  TRoutes extends readonly AnyFragnoRouteConfig[] = [],
  TDeps = EmptyObject,
  TServices extends Record<string, unknown> = Record<string, unknown>,
> {
  config: FragnoLibrarySharedConfig<TRoutes>;
  deps: TDeps;
  services: TServices;
  handler: (req: Request) => Promise<Response>;
  mountRoute: string;
  withMiddleware: (
    handler: FragnoMiddlewareCallback<TRoutes, TDeps, TServices>,
  ) => FragnoInstantiatedLibrary<TRoutes, TDeps, TServices>;
}

export interface FragnoLibrarySharedConfig<
  TRoutes extends readonly FragnoRouteConfig<
    HTTPMethod,
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    string,
    string
  >[],
> {
  name: string;
  routes: TRoutes;
}

export type AnyFragnoLibrarySharedConfig = FragnoLibrarySharedConfig<
  readonly AnyFragnoRouteConfig[]
>;

interface LibraryDefinition<
  TConfig,
  TDeps = EmptyObject,
  TServices extends Record<string, unknown> = EmptyObject,
> {
  name: string;
  dependencies?: (config: TConfig) => TDeps;
  services?: (config: TConfig, deps: TDeps) => TServices;
}

export class LibraryBuilder<
  TConfig,
  TDeps = EmptyObject,
  TServices extends Record<string, unknown> = EmptyObject,
> {
  #definition: LibraryDefinition<TConfig, TDeps, TServices>;

  constructor(definition: LibraryDefinition<TConfig, TDeps, TServices>) {
    this.#definition = definition;
  }

  get definition() {
    return this.#definition;
  }

  withDependencies<TNewDeps>(
    fn: (config: TConfig) => TNewDeps,
  ): LibraryBuilder<TConfig, TNewDeps, TServices> {
    return new LibraryBuilder<TConfig, TNewDeps, TServices>({
      ...this.#definition,
      dependencies: fn,
    } as LibraryDefinition<TConfig, TNewDeps, TServices>);
  }

  withServices<TNewServices extends Record<string, unknown>>(
    fn: (config: TConfig, deps: TDeps) => TNewServices,
  ): LibraryBuilder<TConfig, TDeps, TNewServices> {
    return new LibraryBuilder<TConfig, TDeps, TNewServices>({
      ...this.#definition,
      services: fn,
    } as LibraryDefinition<TConfig, TDeps, TNewServices>);
  }
}

export function defineLibrary<TConfig>(name: string): LibraryBuilder<TConfig> {
  return new LibraryBuilder({
    name,
  });
}

export function createLibrary<
  TConfig,
  TDeps,
  TServices extends Record<string, unknown>,
  const TRoutesOrFactories extends readonly AnyRouteOrFactory[],
>(
  libraryDefinition: LibraryBuilder<TConfig, TDeps, TServices>,
  config: TConfig,
  routesOrFactories: TRoutesOrFactories,
  fragnoConfig: FragnoPublicConfig = {},
): FragnoInstantiatedLibrary<FlattenRouteFactories<TRoutesOrFactories>, TDeps, TServices> {
  const definition = libraryDefinition.definition;

  const dependencies = definition.dependencies ? definition.dependencies(config) : ({} as TDeps);
  const services = definition.services
    ? definition.services(config, dependencies)
    : ({} as TServices);

  const context = { config, deps: dependencies, services };
  const routes = resolveRouteFactories(context, routesOrFactories);

  const mountRoute = getMountRoute({
    name: definition.name,
    mountRoute: fragnoConfig.mountRoute,
  });

  const router =
    createRouter<
      FragnoRouteConfig<
        HTTPMethod,
        string,
        StandardSchemaV1 | undefined,
        StandardSchemaV1 | undefined,
        string,
        string
      >
    >();

  let middlewareHandler:
    | FragnoMiddlewareCallback<FlattenRouteFactories<TRoutesOrFactories>, TDeps, TServices>
    | undefined;

  for (const routeConfig of routes) {
    addRoute(router, routeConfig.method.toUpperCase(), routeConfig.path, routeConfig);
  }

  const library: FragnoInstantiatedLibrary<
    FlattenRouteFactories<TRoutesOrFactories>,
    TDeps,
    TServices
  > = {
    mountRoute,
    config: {
      name: definition.name,
      routes,
    },
    services,
    deps: dependencies,
    withMiddleware: (handler) => {
      if (middlewareHandler) {
        throw new Error("Middleware already set");
      }

      middlewareHandler = handler;

      return library;
    },
    handler: async (req: Request) => {
      const url = new URL(req.url);
      const pathname = url.pathname;

      const matchRoute = pathname.startsWith(mountRoute) ? pathname.slice(mountRoute.length) : null;

      if (matchRoute === null) {
        return Response.json(
          {
            error:
              `Fragno: Route for '${definition.name}' not found. Is the library mounted on the right route? ` +
              `Expecting: '${mountRoute}'.`,
            code: "ROUTE_NOT_FOUND",
          },
          { status: 404 },
        );
      }

      const route = findRoute(router, req.method, matchRoute);

      if (!route) {
        return Response.json(
          { error: `Fragno: Route for '${definition.name}' not found`, code: "ROUTE_NOT_FOUND" },
          { status: 404 },
        );
      }

      const { handler, inputSchema, outputSchema, path } = route.data;

      const outputContext = new RequestOutputContext(outputSchema);

      if (middlewareHandler) {
        const middlewareContext = new RequestMiddlewareContext(routes, {
          method: req.method as HTTPMethod,
          path,
          pathParams: route.params,
          searchParams: new URL(req.url).searchParams,
          body: req.body,
          request: req,
        });

        try {
          const middlewareResult = await middlewareHandler(middlewareContext, {
            deps: dependencies,
            services,
          });
          if (middlewareResult !== undefined) {
            return middlewareResult;
          }
        } catch (error) {
          console.error("Error in middleware", error);
          return Response.json(
            { error: "Internal server error", code: "INTERNAL_SERVER_ERROR" },
            { status: 500 },
          );
        }
      }

      const inputContext = await RequestInputContext.fromRequest({
        request: req,
        method: req.method,
        path,
        pathParams: (route.params ?? {}) as ExtractPathParams<typeof path>,
        inputSchema,
      });

      try {
        const result = await handler(inputContext, outputContext);
        return result;
      } catch (error) {
        console.error("Error in handler", error);

        if (error instanceof FragnoApiError) {
          return error.toResponse();
        }

        return Response.json(
          { error: "Internal server error", code: "INTERNAL_SERVER_ERROR" },
          { status: 500 },
        );
      }
    },
  };

  return library;
}
