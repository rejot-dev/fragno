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
import {
  RequestMiddlewareInputContext,
  RequestMiddlewareOutputContext,
  type FragnoMiddlewareCallback,
} from "./request-middleware";

export interface FragnoPublicConfig {
  mountRoute?: string;
}

export interface FragnoPublicClientConfig {
  mountRoute?: string;
  baseUrl?: string;
}

type AstroHandlers = {
  ALL: (req: Request) => Promise<Response>;
};

type ReactRouterHandlers = {
  loader: (args: { request: Request }) => Promise<Response>;
  action: (args: { request: Request }) => Promise<Response>;
};

type StandardHandlers = {
  GET: (req: Request) => Promise<Response>;
  POST: (req: Request) => Promise<Response>;
  PUT: (req: Request) => Promise<Response>;
  DELETE: (req: Request) => Promise<Response>;
  PATCH: (req: Request) => Promise<Response>;
  HEAD: (req: Request) => Promise<Response>;
  OPTIONS: (req: Request) => Promise<Response>;
};

type HandlersByFramework = {
  astro: AstroHandlers;
  "react-router": ReactRouterHandlers;
  "next-js": StandardHandlers;
  "svelte-kit": StandardHandlers;
};

type FullstackFrameworks = keyof HandlersByFramework;

export interface FragnoInstantiatedFragment<
  TRoutes extends readonly AnyFragnoRouteConfig[] = [],
  TDeps = EmptyObject,
  TServices extends Record<string, unknown> = Record<string, unknown>,
> {
  config: FragnoFragmentSharedConfig<TRoutes>;
  deps: TDeps;
  services: TServices;
  handlersFor: <T extends FullstackFrameworks>(framework: T) => HandlersByFramework[T];
  handler: (req: Request) => Promise<Response>;
  mountRoute: string;
  withMiddleware: (
    handler: FragnoMiddlewareCallback<TRoutes, TDeps, TServices>,
  ) => FragnoInstantiatedFragment<TRoutes, TDeps, TServices>;
}

export interface FragnoFragmentSharedConfig<
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

export type AnyFragnoFragmentSharedConfig = FragnoFragmentSharedConfig<
  readonly AnyFragnoRouteConfig[]
>;

interface FragmentDefinition<
  TConfig,
  TDeps = EmptyObject,
  TServices extends Record<string, unknown> = EmptyObject,
> {
  name: string;
  dependencies?: (config: TConfig) => TDeps;
  services?: (config: TConfig, deps: TDeps) => TServices;
}

export class FragmentBuilder<
  TConfig,
  TDeps = EmptyObject,
  TServices extends Record<string, unknown> = EmptyObject,
> {
  #definition: FragmentDefinition<TConfig, TDeps, TServices>;

  constructor(definition: FragmentDefinition<TConfig, TDeps, TServices>) {
    this.#definition = definition;
  }

  get definition() {
    return this.#definition;
  }

  withDependencies<TNewDeps>(
    fn: (config: TConfig) => TNewDeps,
  ): FragmentBuilder<TConfig, TNewDeps, TServices> {
    return new FragmentBuilder<TConfig, TNewDeps, TServices>({
      ...this.#definition,
      dependencies: fn,
    } as FragmentDefinition<TConfig, TNewDeps, TServices>);
  }

  withServices<TNewServices extends Record<string, unknown>>(
    fn: (config: TConfig, deps: TDeps) => TNewServices,
  ): FragmentBuilder<TConfig, TDeps, TNewServices> {
    return new FragmentBuilder<TConfig, TDeps, TNewServices>({
      ...this.#definition,
      services: fn,
    } as FragmentDefinition<TConfig, TDeps, TNewServices>);
  }
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export function defineFragment<TConfig = {}>(name: string): FragmentBuilder<TConfig> {
  return new FragmentBuilder({
    name,
  });
}

export function createFragment<
  TConfig,
  TDeps,
  TServices extends Record<string, unknown>,
  const TRoutesOrFactories extends readonly AnyRouteOrFactory[],
>(
  fragmentDefinition: FragmentBuilder<TConfig, TDeps, TServices>,
  config: TConfig,
  routesOrFactories: TRoutesOrFactories,
  fragnoConfig: FragnoPublicConfig = {},
): FragnoInstantiatedFragment<FlattenRouteFactories<TRoutesOrFactories>, TDeps, TServices> {
  const definition = fragmentDefinition.definition;

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

  const fragment: FragnoInstantiatedFragment<
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

      return fragment;
    },
    handlersFor: <T extends FullstackFrameworks>(framework: T): HandlersByFramework[T] => {
      const handler = fragment.handler;

      // LLMs hallucinate these values sometimes, solution isn't obvious so we throw this error
      // @ts-expect-error TS2367
      if (framework === "h3" || framework === "nuxt") {
        throw new Error(`To get handlers for h3, use the 'fromWebHandler' utility function:
          import { fromWebHandler } from "h3";
          export default fromWebHandler(myFragment().handler);`);
      }
      const allHandlers = {
        astro: { ALL: handler },
        "react-router": {
          loader: ({ request }: { request: Request }) => handler(request),
          action: ({ request }: { request: Request }) => handler(request),
        },
        "next-js": {
          GET: handler,
          POST: handler,
          PUT: handler,
          DELETE: handler,
          PATCH: handler,
          HEAD: handler,
          OPTIONS: handler,
        },
        "svelte-kit": {
          GET: handler,
          POST: handler,
          PUT: handler,
          DELETE: handler,
          PATCH: handler,
          HEAD: handler,
          OPTIONS: handler,
        },
      } satisfies HandlersByFramework;

      return allHandlers[framework];
    },
    handler: async (req: Request) => {
      const url = new URL(req.url);
      const pathname = url.pathname;

      const matchRoute = pathname.startsWith(mountRoute) ? pathname.slice(mountRoute.length) : null;

      if (matchRoute === null) {
        return Response.json(
          {
            error:
              `Fragno: Route for '${definition.name}' not found. Is the fragment mounted on the right route? ` +
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
        const middlewareInputContext = new RequestMiddlewareInputContext(routes, {
          method: req.method as HTTPMethod,
          path,
          pathParams: route.params,
          searchParams: new URL(req.url).searchParams,
          body: req.body,
          request: req,
        });

        const middlewareOutputContext = new RequestMiddlewareOutputContext(dependencies, services);

        try {
          const middlewareResult = await middlewareHandler(
            middlewareInputContext,
            middlewareOutputContext,
          );
          if (middlewareResult !== undefined) {
            return middlewareResult;
          }
        } catch (error) {
          console.error("Error in middleware", error);

          if (error instanceof FragnoApiError) {
            // TODO: If a validation error occurs in middleware (when calling `await input.valid()`)
            //       the processing is short-circuited and a potential `catch` block around the call
            //       to `input.valid()` in the actual handler will not be executed.
            return error.toResponse();
          }

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

  return fragment;
}
