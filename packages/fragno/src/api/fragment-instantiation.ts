import type { StandardSchemaV1 } from "@standard-schema/spec";
import { type FragnoRouteConfig, type HTTPMethod } from "./api";
import { FragnoApiError } from "./error";
import { getMountRoute } from "./internal/route";
import { addRoute, createRouter, findRoute } from "rou3";
import { RequestInputContext, type RequestBodyType } from "./request-input-context";
import type { ExtractPathParams } from "./internal/path";
import { RequestOutputContext } from "./request-output-context";
import {
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
import type { FragmentDefinition } from "./fragment-builder";
import { MutableRequestState } from "./mutable-request-state";
import type { RouteHandlerInputOptions } from "./route-handler-input-options";
import type { ExtractRouteByPath, ExtractRoutePath } from "../client/client";
import { type FragnoResponse, parseFragnoResponse } from "./fragno-response";
import type { InferOrUnknown } from "../util/types-util";

export interface FragnoPublicConfig {
  mountRoute?: string;
}

export type FetcherConfig =
  | { type: "options"; options: RequestInit }
  | { type: "function"; fetcher: typeof fetch };

export interface FragnoPublicClientConfig {
  mountRoute?: string;
  baseUrl?: string;
  fetcherConfig?: FetcherConfig;
}

type AstroHandlers = {
  ALL: (req: Request) => Promise<Response>;
};

type ReactRouterHandlers = {
  loader: (args: { request: Request }) => Promise<Response>;
  action: (args: { request: Request }) => Promise<Response>;
};

type SolidStartHandlers = {
  GET: (args: { request: Request }) => Promise<Response>;
  POST: (args: { request: Request }) => Promise<Response>;
  PUT: (args: { request: Request }) => Promise<Response>;
  DELETE: (args: { request: Request }) => Promise<Response>;
  PATCH: (args: { request: Request }) => Promise<Response>;
  HEAD: (args: { request: Request }) => Promise<Response>;
  OPTIONS: (args: { request: Request }) => Promise<Response>;
};

type TanStackStartHandlers = SolidStartHandlers;

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
  "solid-start": SolidStartHandlers;
  "tanstack-start": TanStackStartHandlers;
};

// Not actually a symbol, since we might be dealing with multiple instances of this code.
export const instantiatedFragmentFakeSymbol = "$fragno-instantiated-fragment" as const;

type FullstackFrameworks = keyof HandlersByFramework;

export interface FragnoInstantiatedFragment<
  TRoutes extends readonly AnyFragnoRouteConfig[] = [],
  TDeps = {},
  TServices extends Record<string, unknown> = Record<string, unknown>,
  TAdditionalContext extends Record<string, unknown> = {},
> {
  [instantiatedFragmentFakeSymbol]: typeof instantiatedFragmentFakeSymbol;

  config: FragnoFragmentSharedConfig<TRoutes>;
  deps: TDeps;
  services: TServices;
  additionalContext?: TAdditionalContext;
  handlersFor: <T extends FullstackFrameworks>(framework: T) => HandlersByFramework[T];
  handler: (req: Request) => Promise<Response>;
  mountRoute: string;
  callRoute: <TMethod extends HTTPMethod, TPath extends ExtractRoutePath<TRoutes, TMethod>>(
    method: TMethod,
    path: TPath,
    inputOptions?: RouteHandlerInputOptions<
      TPath,
      ExtractRouteByPath<TRoutes, TPath, TMethod>["inputSchema"]
    >,
  ) => Promise<
    FragnoResponse<
      InferOrUnknown<NonNullable<ExtractRouteByPath<TRoutes, TPath, TMethod>["outputSchema"]>>
    >
  >;
  callRouteRaw: <TMethod extends HTTPMethod, TPath extends ExtractRoutePath<TRoutes, TMethod>>(
    method: TMethod,
    path: TPath,
    inputOptions?: RouteHandlerInputOptions<
      TPath,
      ExtractRouteByPath<TRoutes, TPath, TMethod>["inputSchema"]
    >,
  ) => Promise<Response>;
  withMiddleware: (
    handler: FragnoMiddlewareCallback<TRoutes, TDeps, TServices>,
  ) => FragnoInstantiatedFragment<TRoutes, TDeps, TServices, TAdditionalContext>;
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

export function createFragment<
  const TConfig,
  const TDeps,
  const TServices extends Record<string, unknown>,
  const TRoutesOrFactories extends readonly AnyRouteOrFactory[],
  const TAdditionalContext extends Record<string, unknown>,
  const TOptions extends FragnoPublicConfig,
>(
  fragmentBuilder: {
    definition: FragmentDefinition<TConfig, TDeps, TServices, TAdditionalContext>;
    $requiredOptions: TOptions;
  },
  config: TConfig,
  routesOrFactories: TRoutesOrFactories,
  options: TOptions,
): FragnoInstantiatedFragment<
  FlattenRouteFactories<TRoutesOrFactories>,
  TDeps,
  TServices,
  TAdditionalContext
> {
  type TRoutes = FlattenRouteFactories<TRoutesOrFactories>;

  const definition = fragmentBuilder.definition;

  const dependencies = definition.dependencies?.(config, options) ?? ({} as TDeps);
  const services = definition.services?.(config, options, dependencies) ?? ({} as TServices);

  const context = { config, deps: dependencies, services };
  const routes = resolveRouteFactories(context, routesOrFactories);

  const mountRoute = getMountRoute({
    name: definition.name,
    mountRoute: options.mountRoute,
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
    TServices,
    TAdditionalContext & TOptions
  > = {
    [instantiatedFragmentFakeSymbol]: instantiatedFragmentFakeSymbol,
    mountRoute,
    config: {
      name: definition.name,
      routes,
    },
    services,
    deps: dependencies,
    additionalContext: {
      ...definition.additionalContext,
      ...options,
    } as TAdditionalContext & TOptions,
    withMiddleware: (handler) => {
      if (middlewareHandler) {
        throw new Error("Middleware already set");
      }

      middlewareHandler = handler;

      return fragment;
    },
    callRoute: async <TMethod extends HTTPMethod, TPath extends ExtractRoutePath<TRoutes, TMethod>>(
      method: TMethod,
      path: TPath,
      inputOptions?: RouteHandlerInputOptions<
        TPath,
        ExtractRouteByPath<TRoutes, TPath, TMethod>["inputSchema"]
      >,
    ): Promise<
      FragnoResponse<
        InferOrUnknown<NonNullable<ExtractRouteByPath<TRoutes, TPath, TMethod>["outputSchema"]>>
      >
    > => {
      const response = await fragment.callRouteRaw(method, path, inputOptions);
      return parseFragnoResponse(response);
    },
    callRouteRaw: async <
      TMethod extends HTTPMethod,
      TPath extends ExtractRoutePath<TRoutes, TMethod>,
    >(
      method: TMethod,
      path: TPath,
      inputOptions?: RouteHandlerInputOptions<
        TPath,
        ExtractRouteByPath<TRoutes, TPath, TMethod>["inputSchema"]
      >,
    ): Promise<Response> => {
      // Find the route configuration
      const route = routes.find((r) => r.method === method && r.path === path);

      if (!route) {
        return Response.json(
          {
            error: `Route ${method} ${path} not found`,
            code: "ROUTE_NOT_FOUND",
          },
          { status: 404 },
        );
      }

      const {
        pathParams = {} as ExtractPathParams<TPath>,
        body,
        query,
        headers,
      } = inputOptions || {};

      // Convert query to URLSearchParams if needed
      const searchParams =
        query instanceof URLSearchParams
          ? query
          : query
            ? new URLSearchParams(query)
            : new URLSearchParams();

      // Convert headers to Headers if needed
      const requestHeaders =
        headers instanceof Headers ? headers : headers ? new Headers(headers) : new Headers();

      // Construct RequestInputContext
      const inputContext = new RequestInputContext({
        path: route.path,
        method: route.method,
        pathParams,
        searchParams,
        headers: requestHeaders,
        parsedBody: body,
        inputSchema: route.inputSchema,
        shouldValidateInput: true, // Enable validation for production use
      });

      // Construct RequestOutputContext
      const outputContext = new RequestOutputContext(route.outputSchema);

      // Call the route handler
      try {
        const response = await route.handler(inputContext, outputContext);
        return response;
      } catch (error) {
        console.error("Error in callRoute handler", error);

        if (error instanceof FragnoApiError) {
          return error.toResponse();
        }

        return Response.json(
          { error: "Internal server error", code: "INTERNAL_SERVER_ERROR" },
          { status: 500 },
        );
      }
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
        "solid-start": {
          GET: ({ request }: { request: Request }) => handler(request),
          POST: ({ request }: { request: Request }) => handler(request),
          PUT: ({ request }: { request: Request }) => handler(request),
          DELETE: ({ request }: { request: Request }) => handler(request),
          PATCH: ({ request }: { request: Request }) => handler(request),
          HEAD: ({ request }: { request: Request }) => handler(request),
          OPTIONS: ({ request }: { request: Request }) => handler(request),
        },
        "tanstack-start": {
          GET: ({ request }: { request: Request }) => handler(request),
          POST: ({ request }: { request: Request }) => handler(request),
          PUT: ({ request }: { request: Request }) => handler(request),
          DELETE: ({ request }: { request: Request }) => handler(request),
          PATCH: ({ request }: { request: Request }) => handler(request),
          HEAD: ({ request }: { request: Request }) => handler(request),
          OPTIONS: ({ request }: { request: Request }) => handler(request),
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

      // Create mutable request state that can be modified by middleware
      // Clone the request to read body as both text and JSON without consuming original stream
      let requestBody: RequestBodyType = undefined;
      let rawBody: string | undefined = undefined;

      if (req.body instanceof ReadableStream) {
        // Clone request to make sure we don't consume body stream
        const clonedReq = req.clone();

        // Get raw text
        rawBody = await clonedReq.text();

        // Parse JSON if body is not empty
        if (rawBody) {
          try {
            requestBody = JSON.parse(rawBody);
          } catch {
            // If JSON parsing fails, keep body as undefined
            // This handles cases where body is not JSON
            requestBody = undefined;
          }
        }
      }

      const requestState = new MutableRequestState({
        pathParams: route.params ?? {},
        searchParams: url.searchParams,
        body: requestBody,
        headers: new Headers(req.headers),
      });

      if (middlewareHandler) {
        const middlewareInputContext = new RequestMiddlewareInputContext(routes, {
          method: req.method as HTTPMethod,
          path,
          request: req,
          state: requestState,
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
        state: requestState,
        rawBody,
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
