import type { StandardSchemaV1 } from "@standard-schema/spec";
import { type FragnoRouteConfig, type HTTPMethod, type RequestThisContext } from "./api";
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
import { MutableRequestState } from "./mutable-request-state";
import type { RouteHandlerInputOptions } from "./route-handler-input-options";
import type { ExtractRouteByPath, ExtractRoutePath } from "../client/client";
import { type FragnoResponse, parseFragnoResponse } from "./fragno-response";
import type { InferOrUnknown } from "../util/types-util";
import type { FragmentDefinition } from "./fragment-definition-builder";
import type { FragnoPublicConfig } from "./shared-types";
import { RequestContextStorage } from "./request-context-storage";
import { bindServicesToContext, type BoundServices } from "./bind-services";
import { instantiatedFragmentFakeSymbol } from "../internal/symbols";
import { recordTraceEvent } from "../internal/trace-context";

// Re-export types needed by consumers
export type { BoundServices };

type InternalRoutePrefix = "/_internal";

type JoinInternalRoutePath<TPath extends string> = TPath extends "" | "/"
  ? InternalRoutePrefix
  : TPath extends `/${string}`
    ? `${InternalRoutePrefix}${TPath}`
    : `${InternalRoutePrefix}/${TPath}`;

type PrefixInternalRoute<TRoute> =
  TRoute extends FragnoRouteConfig<
    infer TMethod,
    infer TPath,
    infer TInputSchema,
    infer TOutputSchema,
    infer TErrorCode,
    infer TQueryParameters,
    infer TThisContext
  >
    ? FragnoRouteConfig<
        TMethod,
        JoinInternalRoutePath<TPath>,
        TInputSchema,
        TOutputSchema,
        TErrorCode,
        TQueryParameters,
        TThisContext
      >
    : never;

type PrefixInternalRoutes<TRoutes extends readonly AnyFragnoRouteConfig[]> =
  TRoutes extends readonly [...infer TRoutesTuple]
    ? { [K in keyof TRoutesTuple]: PrefixInternalRoute<TRoutesTuple[K]> }
    : readonly AnyFragnoRouteConfig[];

type ExtractRoutesFromFragment<T> =
  T extends FragnoInstantiatedFragment<
    infer TRoutes,
    infer _TDeps,
    infer _TServices,
    infer _TServiceThisContext,
    infer _THandlerThisContext,
    infer _TRequestStorage,
    infer _TOptions,
    infer _TLinkedFragments
  >
    ? TRoutes
    : never;

type InternalLinkedRoutes<TLinkedFragments> =
  TLinkedFragments extends Record<string, AnyFragnoInstantiatedFragment>
    ? TLinkedFragments extends { _fragno_internal: infer TInternal }
      ? ExtractRoutesFromFragment<TInternal> extends readonly AnyFragnoRouteConfig[]
        ? PrefixInternalRoutes<ExtractRoutesFromFragment<TInternal>>
        : readonly []
      : readonly []
    : readonly [];

export type RoutesWithInternal<
  TRoutes extends readonly AnyFragnoRouteConfig[],
  TLinkedFragments,
> = readonly [...TRoutes, ...InternalLinkedRoutes<TLinkedFragments>];

/**
 * Helper type to extract the instantiated fragment type from a fragment definition.
 * This is useful for typing functions that accept instantiated fragments based on their definition.
 *
 * @example
 * ```typescript
 * const myFragmentDef = defineFragment("my-fragment").build();
 * type MyInstantiatedFragment = InstantiatedFragmentFromDefinition<typeof myFragmentDef>;
 * ```
 */
export type InstantiatedFragmentFromDefinition<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDef extends FragmentDefinition<any, any, any, any, any, any, any, any, any, any, any>,
> =
  TDef extends FragmentDefinition<
    infer _TConfig,
    infer TOptions,
    infer TDeps,
    infer TBaseServices,
    infer TServices,
    infer _TServiceDependencies,
    infer _TPrivateServices,
    infer TServiceThisContext,
    infer THandlerThisContext,
    infer TRequestStorage,
    infer TLinkedFragments
  >
    ? FragnoInstantiatedFragment<
        RoutesWithInternal<readonly AnyFragnoRouteConfig[], TLinkedFragments>,
        TDeps,
        BoundServices<TBaseServices & TServices>,
        TServiceThisContext,
        THandlerThisContext,
        TRequestStorage,
        TOptions,
        TLinkedFragments
      >
    : never;

type AstroHandlers = {
  ALL: (req: Request) => Promise<Response>;
};

type ReactRouterHandlers = {
  loader: (args: { request: Request }) => Promise<Response>;
  action: (args: { request: Request }) => Promise<Response>;
};

const serializeHeadersForTrace = (headers: Headers): [string, string][] =>
  Array.from(headers.entries()).sort(([a], [b]) => a.localeCompare(b));

const serializeQueryForTrace = (query: URLSearchParams): [string, string][] =>
  Array.from(query.entries()).sort(([a], [b]) => a.localeCompare(b));

const serializeBodyForTrace = (body: RequestBodyType): unknown => {
  if (body instanceof FormData) {
    const entries = Array.from(body.entries()).map(([key, value]) => {
      if (value instanceof Blob) {
        return [key, { type: "blob", size: value.size, mime: value.type }] as const;
      }
      return [key, value] as const;
    });
    return { type: "form-data", entries };
  }

  if (body instanceof Blob) {
    return { type: "blob", size: body.size, mime: body.type };
  }

  if (body instanceof ReadableStream) {
    return { type: "stream" };
  }

  return body;
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

type FullstackFrameworks = keyof HandlersByFramework;

export type AnyFragnoInstantiatedFragment = FragnoInstantiatedFragment<
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
  any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any
>;

const INTERNAL_LINKED_FRAGMENT_NAME = "_fragno_internal";
const INTERNAL_ROUTE_PREFIX = "/_internal";

type InternalLinkedRouteMeta = {
  fragment: AnyFragnoInstantiatedFragment;
  originalPath: string;
  routes: readonly AnyFragnoRouteConfig[];
};

type InternalLinkedRouteConfig = AnyFragnoRouteConfig & {
  __internal?: InternalLinkedRouteMeta;
};

function normalizeRoutePrefix(prefix: string): string {
  if (!prefix.startsWith("/")) {
    prefix = `/${prefix}`;
  }
  return prefix.endsWith("/") && prefix.length > 1 ? prefix.slice(0, -1) : prefix;
}

function joinRoutePath(prefix: string, path: string): string {
  const normalizedPrefix = normalizeRoutePrefix(prefix);
  if (!path || path === "/") {
    return normalizedPrefix;
  }
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedPrefix}${normalizedPath}`;
}

function collectLinkedFragmentRoutes(
  linkedFragments: Record<string, AnyFragnoInstantiatedFragment>,
): InternalLinkedRouteConfig[] {
  const linkedRoutes: InternalLinkedRouteConfig[] = [];

  for (const [name, fragment] of Object.entries(linkedFragments)) {
    if (name !== INTERNAL_LINKED_FRAGMENT_NAME) {
      continue;
    }

    const internalRoutes = (fragment.routes ?? []) as readonly AnyFragnoRouteConfig[];
    if (internalRoutes.length === 0) {
      continue;
    }

    for (const route of internalRoutes) {
      linkedRoutes.push({
        ...route,
        path: joinRoutePath(INTERNAL_ROUTE_PREFIX, route.path),
        __internal: {
          fragment,
          originalPath: route.path,
          routes: internalRoutes,
        },
      });
    }
  }

  return linkedRoutes;
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

/**
 * Instantiated fragment class with encapsulated state.
 * Provides the same public API as the old FragnoInstantiatedFragment but with better encapsulation.
 */
export class FragnoInstantiatedFragment<
  TRoutes extends readonly AnyFragnoRouteConfig[],
  TDeps,
  TServices extends Record<string, unknown>,
  TServiceThisContext extends RequestThisContext,
  THandlerThisContext extends RequestThisContext,
  TRequestStorage = {},
  TOptions extends FragnoPublicConfig = FragnoPublicConfig,
  TLinkedFragments extends Record<string, AnyFragnoInstantiatedFragment> = {},
> implements IFragnoInstantiatedFragment
{
  readonly [instantiatedFragmentFakeSymbol] = instantiatedFragmentFakeSymbol;

  // Private fields
  #name: string;
  #routes: TRoutes;
  #deps: TDeps;
  #services: TServices;
  #mountRoute: string;
  #router: ReturnType<typeof createRouter>;
  #middlewareHandler?: FragnoMiddlewareCallback<TRoutes, TDeps, TServices>;
  #serviceThisContext?: TServiceThisContext; // Context for services (may have restricted capabilities)
  #handlerThisContext?: THandlerThisContext; // Context for handlers (full capabilities)
  #contextStorage: RequestContextStorage<TRequestStorage>;
  #createRequestStorage?: () => TRequestStorage;
  #options: TOptions;
  #linkedFragments: TLinkedFragments;
  #internalData: Record<string, unknown>;

  constructor(params: {
    name: string;
    routes: TRoutes;
    deps: TDeps;
    services: TServices;
    mountRoute: string;
    serviceThisContext?: TServiceThisContext;
    handlerThisContext?: THandlerThisContext;
    storage: RequestContextStorage<TRequestStorage>;
    createRequestStorage?: () => TRequestStorage;
    options: TOptions;
    linkedFragments?: TLinkedFragments;
    internalData?: Record<string, unknown>;
  }) {
    this.#name = params.name;
    this.#routes = params.routes;
    this.#deps = params.deps;
    this.#services = params.services;
    this.#mountRoute = params.mountRoute;
    this.#serviceThisContext = params.serviceThisContext;
    this.#handlerThisContext = params.handlerThisContext;
    this.#contextStorage = params.storage;
    this.#createRequestStorage = params.createRequestStorage;
    this.#options = params.options;
    this.#linkedFragments = params.linkedFragments ?? ({} as TLinkedFragments);
    this.#internalData = params.internalData ?? {};

    // Build router
    this.#router =
      createRouter<
        FragnoRouteConfig<
          HTTPMethod,
          string,
          StandardSchemaV1 | undefined,
          StandardSchemaV1 | undefined,
          string,
          string,
          RequestThisContext
        >
      >();

    for (const routeConfig of this.#routes) {
      addRoute(this.#router, routeConfig.method.toUpperCase(), routeConfig.path, routeConfig);
    }

    // Bind handler method to maintain 'this' context
    this.handler = this.handler.bind(this);
  }

  // Public getters
  get name(): string {
    return this.#name;
  }

  get routes(): TRoutes {
    return this.#routes;
  }

  get services(): TServices {
    return this.#services;
  }

  get mountRoute(): string {
    return this.#mountRoute;
  }

  /**
   * @internal
   */
  get $internal() {
    return {
      deps: this.#deps,
      options: this.#options,
      linkedFragments: this.#linkedFragments,
      ...this.#internalData,
    };
  }

  /**
   * Add middleware to this fragment.
   * Middleware can inspect and modify requests before they reach handlers.
   */
  withMiddleware(handler: FragnoMiddlewareCallback<TRoutes, TDeps, TServices>): this {
    if (this.#middlewareHandler) {
      throw new Error("Middleware already set");
    }
    this.#middlewareHandler = handler;
    return this;
  }

  /**
   * Run a callback within the fragment's request context with initialized storage.
   * This is a shared helper used by inContext(), handler(), and callRouteRaw().
   * @private
   */
  #withRequestStorage<T>(callback: () => T): T;
  #withRequestStorage<T>(callback: () => Promise<T>): Promise<T>;
  #withRequestStorage<T>(callback: () => T | Promise<T>): T | Promise<T> {
    if (!this.#serviceThisContext && !this.#handlerThisContext) {
      // No request context configured - just run callback directly
      return callback();
    }

    // Initialize storage with fresh data for this request
    const storageData = this.#createRequestStorage
      ? this.#createRequestStorage()
      : ({} as TRequestStorage);
    return this.#contextStorage.run(storageData, callback);
  }

  /**
   * Execute a callback within a request context.
   * Establishes an async context for the duration of the callback, allowing services
   * to access the `this` context. The callback's `this` will be bound to the fragment's
   * handler context (with full capabilities including execute methods).
   * Useful for calling services outside of route handlers (e.g., in tests, background jobs).
   *
   * @param callback - The callback to run within the context
   *
   * @example
   * ```typescript
   * const result = await fragment.inContext(function () {
   *   // `this` is bound to the handler context (can call execute methods)
   *   await this.getUnitOfWork().executeRetrieve();
   *   return this.someContextMethod();
   * });
   * ```
   */
  inContext<T>(callback: (this: THandlerThisContext) => T): T;
  inContext<T>(callback: (this: THandlerThisContext) => Promise<T>): Promise<T>;
  inContext<T>(callback: (this: THandlerThisContext) => T | Promise<T>): T | Promise<T> {
    // Always use handler context for inContext - it has full capabilities
    if (this.#handlerThisContext) {
      const boundCallback = callback.bind(this.#handlerThisContext);
      return this.#withRequestStorage(boundCallback);
    }
    return this.#withRequestStorage(callback);
  }

  /**
   * Get framework-specific handlers for this fragment.
   * Use this to integrate the fragment with different fullstack frameworks.
   */
  handlersFor<T extends FullstackFrameworks>(framework: T): HandlersByFramework[T] {
    const handler = this.handler.bind(this);

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
  }

  /**
   * Main request handler for this fragment.
   * Handles routing, middleware, and error handling.
   */
  async handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // Match route
    const matchRoute = pathname.startsWith(this.#mountRoute)
      ? pathname.slice(this.#mountRoute.length)
      : null;

    if (matchRoute === null) {
      return Response.json(
        {
          error:
            `Fragno: Route for '${this.#name}' not found. Is the fragment mounted on the right route? ` +
            `Expecting: '${this.#mountRoute}'.`,
          code: "ROUTE_NOT_FOUND",
        },
        { status: 404 },
      );
    }

    const route = findRoute(this.#router, req.method, matchRoute);

    if (!route) {
      return Response.json(
        { error: `Fragno: Route for '${this.#name}' not found`, code: "ROUTE_NOT_FOUND" },
        { status: 404 },
      );
    }

    // Get the expected content type from route config (default: application/json)
    const routeConfig = route.data as InternalLinkedRouteConfig;
    const expectedContentType = routeConfig.contentType ?? "application/json";

    // Parse request body based on route's expected content type
    let requestBody: RequestBodyType = undefined;
    let rawBody: string | undefined = undefined;

    if (req.body instanceof ReadableStream) {
      const requestContentType = (req.headers.get("content-type") ?? "").toLowerCase();

      if (expectedContentType === "multipart/form-data") {
        // Route expects FormData (file uploads)
        if (!requestContentType.includes("multipart/form-data")) {
          return Response.json(
            {
              error: `This endpoint expects multipart/form-data, but received: ${requestContentType || "no content-type"}`,
              code: "UNSUPPORTED_MEDIA_TYPE",
            },
            { status: 415 },
          );
        }

        try {
          requestBody = await req.formData();
        } catch {
          return Response.json(
            { error: "Failed to parse multipart form data", code: "INVALID_REQUEST_BODY" },
            { status: 400 },
          );
        }
      } else if (expectedContentType === "application/octet-stream") {
        if (!requestContentType.includes("application/octet-stream")) {
          return Response.json(
            {
              error: `This endpoint expects application/octet-stream, but received: ${requestContentType || "no content-type"}`,
              code: "UNSUPPORTED_MEDIA_TYPE",
            },
            { status: 415 },
          );
        }

        requestBody = req.body ?? new ReadableStream<Uint8Array>();
      } else {
        // Route expects JSON (default)
        // Note: We're lenient here - we accept requests without Content-Type header
        // or with application/json. We reject multipart/form-data for JSON routes.
        if (requestContentType.includes("multipart/form-data")) {
          return Response.json(
            {
              error: `This endpoint expects JSON, but received multipart/form-data. Use a route with contentType: "multipart/form-data" for file uploads.`,
              code: "UNSUPPORTED_MEDIA_TYPE",
            },
            { status: 415 },
          );
        }

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
    }

    // URL decode path params from rou3 (which returns encoded values)
    const decodedRouteParams: Record<string, string> = {};
    for (const [key, value] of Object.entries(route.params ?? {})) {
      decodedRouteParams[key] = decodeURIComponent(value);
    }

    const requestState = new MutableRequestState({
      pathParams: decodedRouteParams,
      searchParams: url.searchParams,
      body: requestBody,
      headers: new Headers(req.headers),
    });

    // Execute middleware and handler
    const executeRequest = async (): Promise<Response> => {
      // Parent middleware execution
      const middlewareResult = await this.#executeMiddleware(req, route, requestState);
      if (middlewareResult !== undefined) {
        return middlewareResult;
      }

      // Internal fragment middleware execution (if linked)
      const internalMeta = routeConfig.__internal;
      if (internalMeta) {
        const internalResult = await FragnoInstantiatedFragment.#runMiddlewareForFragment(
          internalMeta.fragment as AnyFragnoInstantiatedFragment,
          {
            req,
            method: routeConfig.method,
            path: internalMeta.originalPath,
            requestState,
            routes: internalMeta.routes,
          },
        );
        if (internalResult !== undefined) {
          return internalResult;
        }
      }

      // Handler execution
      return this.#executeHandler(req, route, requestState, rawBody);
    };

    // Wrap with request storage context if provided
    return this.#withRequestStorage(executeRequest);
  }

  /**
   * Call a route directly with typed inputs and outputs.
   * Useful for testing and server-side route calls.
   */
  async callRoute<TMethod extends HTTPMethod, TPath extends ExtractRoutePath<TRoutes, TMethod>>(
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
  > {
    const response = await this.callRouteRaw(method, path, inputOptions);
    return parseFragnoResponse(response);
  }

  /**
   * Call a route directly and get the raw Response object.
   * Useful for testing and server-side route calls.
   */
  async callRouteRaw<TMethod extends HTTPMethod, TPath extends ExtractRoutePath<TRoutes, TMethod>>(
    method: TMethod,
    path: TPath,
    inputOptions?: RouteHandlerInputOptions<
      TPath,
      ExtractRouteByPath<TRoutes, TPath, TMethod>["inputSchema"]
    >,
  ): Promise<Response> {
    // Find route in this.#routes
    const route = this.#routes.find((r) => r.method === method && r.path === path);

    if (!route) {
      return Response.json(
        {
          error: `Route ${method} ${path} not found`,
          code: "ROUTE_NOT_FOUND",
        },
        { status: 404 },
      );
    }

    const { pathParams = {}, body, query, headers } = inputOptions || {};

    // Convert query to URLSearchParams if needed
    const searchParams =
      query instanceof URLSearchParams
        ? query
        : query
          ? new URLSearchParams(query)
          : new URLSearchParams();

    const requestHeaders =
      headers instanceof Headers ? headers : headers ? new Headers(headers) : new Headers();

    // Construct RequestInputContext
    const inputContext = new RequestInputContext({
      path: route.path,
      method: route.method,
      pathParams: pathParams as ExtractPathParams<typeof route.path>,
      searchParams,
      headers: requestHeaders,
      parsedBody: body,
      inputSchema: route.inputSchema,
      shouldValidateInput: true, // Enable validation for production use
    });

    recordTraceEvent({
      type: "route-input",
      method: route.method,
      path: route.path,
      pathParams: (pathParams ?? {}) as Record<string, string>,
      queryParams: serializeQueryForTrace(searchParams),
      headers: serializeHeadersForTrace(requestHeaders),
      body: serializeBodyForTrace(body),
    });

    // Construct RequestOutputContext
    const outputContext = new RequestOutputContext(route.outputSchema);

    // Execute handler
    const executeHandler = async (): Promise<Response> => {
      try {
        // Use handler context (full capabilities)
        const thisContext = this.#handlerThisContext ?? ({} as RequestThisContext);
        return await route.handler.call(thisContext, inputContext, outputContext);
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
    };

    // Wrap with request storage context if provided
    return this.#withRequestStorage(executeHandler);
  }

  /**
   * Execute middleware for a request.
   * Returns undefined if middleware allows the request to continue to the handler.
   */
  async #executeMiddleware(
    req: Request,
    route: ReturnType<typeof findRoute>,
    requestState: MutableRequestState,
  ): Promise<Response | undefined> {
    if (!route) {
      return undefined;
    }

    const { path } = route.data as AnyFragnoRouteConfig;
    return FragnoInstantiatedFragment.#runMiddlewareForFragment(this, {
      req,
      method: req.method as HTTPMethod,
      path,
      requestState,
    });
  }

  static async #runMiddlewareForFragment(
    fragment: AnyFragnoInstantiatedFragment,
    options: {
      req: Request;
      method: HTTPMethod;
      path: string;
      requestState: MutableRequestState;
      routes?: readonly AnyFragnoRouteConfig[];
    },
  ): Promise<Response | undefined> {
    if (!fragment.#middlewareHandler) {
      return undefined;
    }

    const middlewareInputContext = new RequestMiddlewareInputContext(
      (options.routes ?? fragment.#routes) as readonly AnyFragnoRouteConfig[],
      {
        method: options.method,
        path: options.path,
        request: options.req,
        state: options.requestState,
      },
    );

    const middlewareOutputContext = new RequestMiddlewareOutputContext(
      fragment.#deps,
      fragment.#services,
    );

    try {
      const middlewareResult = await fragment.#middlewareHandler(
        middlewareInputContext,
        middlewareOutputContext,
      );
      recordTraceEvent({
        type: "middleware-decision",
        method: options.method,
        path: options.path,
        outcome: middlewareResult ? "deny" : "allow",
        status: middlewareResult?.status,
      });
      if (middlewareResult !== undefined) {
        return middlewareResult;
      }
    } catch (error) {
      console.error("Error in middleware", error);

      recordTraceEvent({
        type: "middleware-decision",
        method: options.method,
        path: options.path,
        outcome: "deny",
        status: error instanceof FragnoApiError ? error.status : 500,
      });
      if (error instanceof FragnoApiError) {
        return error.toResponse();
      }

      return Response.json(
        { error: "Internal server error", code: "INTERNAL_SERVER_ERROR" },
        { status: 500 },
      );
    }

    return undefined;
  }

  /**
   * Execute a route handler with proper error handling.
   */
  async #executeHandler(
    req: Request,
    route: ReturnType<typeof findRoute>,
    requestState: MutableRequestState,
    rawBody?: string,
  ): Promise<Response> {
    if (!route) {
      return Response.json({ error: "Route not found", code: "ROUTE_NOT_FOUND" }, { status: 404 });
    }

    const { handler, inputSchema, outputSchema, path } = route.data as AnyFragnoRouteConfig;

    const inputContext = await RequestInputContext.fromRequest({
      request: req,
      method: req.method,
      path,
      pathParams: (route.params ?? {}) as ExtractPathParams<typeof path>,
      inputSchema,
      state: requestState,
      rawBody,
    });

    recordTraceEvent({
      type: "route-input",
      method: req.method,
      path,
      pathParams: inputContext.pathParams as Record<string, string>,
      queryParams: serializeQueryForTrace(requestState.searchParams),
      headers: serializeHeadersForTrace(requestState.headers),
      body: serializeBodyForTrace(requestState.body),
    });

    const outputContext = new RequestOutputContext(outputSchema);

    try {
      // Note: We don't call .run() here because the storage should already be initialized
      // by the handler() method or inContext() method before this point
      // Use handler context (full capabilities)
      const contextForHandler = this.#handlerThisContext ?? ({} as RequestThisContext);
      const result = await handler.call(contextForHandler, inputContext, outputContext);
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
  }
}

/**
 * Options for fragment instantiation.
 */
export interface InstantiationOptions {
  /**
   * If true, catches errors during initialization and returns stub implementations.
   * This is useful for CLI tools that need to extract metadata (like database schemas)
   * without requiring all dependencies to be fully initialized.
   */
  dryRun?: boolean;
}

/**
 * Core instantiation function that creates a fragment instance from a definition.
 * This function validates dependencies, calls all callbacks, and wires everything together.
 */
export function instantiateFragment<
  const TConfig,
  const TOptions extends FragnoPublicConfig,
  const TDeps,
  const TBaseServices extends Record<string, unknown>,
  const TServices extends Record<string, unknown>,
  const TServiceDependencies,
  const TPrivateServices extends Record<string, unknown>,
  const TServiceThisContext extends RequestThisContext,
  const THandlerThisContext extends RequestThisContext,
  const TRequestStorage,
  const TRoutesOrFactories extends readonly AnyRouteOrFactory[],
  const TLinkedFragments extends Record<string, AnyFragnoInstantiatedFragment>,
>(
  definition: FragmentDefinition<
    TConfig,
    TOptions,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    TPrivateServices,
    TServiceThisContext,
    THandlerThisContext,
    TRequestStorage,
    TLinkedFragments
  >,
  config: TConfig,
  routesOrFactories: TRoutesOrFactories,
  options: TOptions,
  serviceImplementations?: TServiceDependencies,
  instantiationOptions?: InstantiationOptions,
): FragnoInstantiatedFragment<
  RoutesWithInternal<FlattenRouteFactories<TRoutesOrFactories>, TLinkedFragments>,
  TDeps,
  BoundServices<TBaseServices & TServices>,
  TServiceThisContext,
  THandlerThisContext,
  TRequestStorage,
  TOptions,
  TLinkedFragments
> {
  const { dryRun = false } = instantiationOptions ?? {};

  // 1. Validate service dependencies
  const serviceDependencies = definition.serviceDependencies;
  if (serviceDependencies) {
    for (const [serviceName, meta] of Object.entries(serviceDependencies)) {
      const metadata = meta as { name: string; required: boolean };
      const implementation = serviceImplementations?.[serviceName as keyof TServiceDependencies];
      if (metadata.required && !implementation) {
        throw new Error(
          `Fragment '${definition.name}' requires service '${metadata.name}' but it was not provided`,
        );
      }
    }
  }

  // 2. Call dependencies callback
  let deps: TDeps;
  try {
    deps = definition.dependencies?.({ config, options }) ?? ({} as TDeps);
  } catch (error) {
    if (dryRun) {
      console.warn(
        "Warning: Failed to initialize dependencies in dry run mode:",
        error instanceof Error ? error.message : String(error),
      );
      // Return empty deps - database fragments will add implicit deps later
      deps = {} as TDeps;
    } else {
      throw error;
    }
  }

  // 3. Calculate mount route early so linked fragments can reference it
  const mountRoute = getMountRoute({
    name: definition.name,
    mountRoute: options.mountRoute,
  });

  // 4. Instantiate linked fragments FIRST (before any services)
  // Their services will be merged into private services
  const linkedFragmentInstances = {} as TLinkedFragments;
  const linkedFragmentServices: Record<string, unknown> = {};

  if (definition.linkedFragments) {
    for (const [name, callback] of Object.entries(definition.linkedFragments)) {
      const linkedFragment = callback({
        config,
        options,
        serviceDependencies: serviceImplementations,
        parent: {
          name: definition.name,
          mountRoute,
        },
      });
      (linkedFragmentInstances as Record<string, AnyFragnoInstantiatedFragment>)[name] =
        linkedFragment;

      // Merge all services from linked fragment into private services directly by their service name
      const services = linkedFragment.services as Record<string, unknown>;
      for (const [serviceName, service] of Object.entries(services)) {
        linkedFragmentServices[serviceName] = service;
      }
    }
  }

  // Identity function for service definition (used to set 'this' context)
  const defineService = <T>(services: T & ThisType<TServiceThisContext>): T => services;

  // 5. Call privateServices factories
  // Private services are instantiated in order, so earlier ones are available to later ones
  // Start with linked fragment services, then add explicitly defined private services
  const privateServices = { ...linkedFragmentServices } as TPrivateServices;
  if (definition.privateServices) {
    for (const [serviceName, factory] of Object.entries(definition.privateServices)) {
      const serviceFactory = factory as (context: {
        config: TConfig;
        options: TOptions;
        deps: TDeps;
        serviceDeps: TServiceDependencies;
        privateServices: TPrivateServices;
        defineService: <T>(svc: T & ThisType<TServiceThisContext>) => T;
      }) => unknown;

      try {
        (privateServices as Record<string, unknown>)[serviceName] = serviceFactory({
          config,
          options,
          deps,
          serviceDeps: (serviceImplementations ?? {}) as TServiceDependencies,
          privateServices, // Pass the current state of private services (earlier ones are available)
          defineService,
        });
      } catch (error) {
        if (dryRun) {
          console.warn(
            `Warning: Failed to initialize private service '${serviceName}' in dry run mode:`,
            error instanceof Error ? error.message : String(error),
          );
          (privateServices as Record<string, unknown>)[serviceName] = {};
        } else {
          throw error;
        }
      }
    }
  }

  // 6. Call baseServices callback (with access to private services including linked fragment services)
  let baseServices: TBaseServices;
  try {
    baseServices =
      definition.baseServices?.({
        config,
        options,
        deps,
        serviceDeps: (serviceImplementations ?? {}) as TServiceDependencies,
        privateServices,
        defineService,
      }) ?? ({} as TBaseServices);
  } catch (error) {
    if (dryRun) {
      console.warn(
        "Warning: Failed to initialize base services in dry run mode:",
        error instanceof Error ? error.message : String(error),
      );
      baseServices = {} as TBaseServices;
    } else {
      throw error;
    }
  }

  // 7. Call namedServices factories (with access to private services including linked fragment services)
  const namedServices = {} as TServices;
  if (definition.namedServices) {
    for (const [serviceName, factory] of Object.entries(definition.namedServices)) {
      const serviceFactory = factory as (context: {
        config: TConfig;
        options: TOptions;
        deps: TDeps;
        serviceDeps: TServiceDependencies;
        privateServices: TPrivateServices;
        defineService: <T>(svc: T & ThisType<TServiceThisContext>) => T;
      }) => unknown;

      try {
        (namedServices as Record<string, unknown>)[serviceName] = serviceFactory({
          config,
          options,
          deps,
          serviceDeps: (serviceImplementations ?? {}) as TServiceDependencies,
          privateServices,
          defineService,
        });
      } catch (error) {
        if (dryRun) {
          console.warn(
            `Warning: Failed to initialize service '${serviceName}' in dry run mode:`,
            error instanceof Error ? error.message : String(error),
          );
          (namedServices as Record<string, unknown>)[serviceName] = {};
        } else {
          throw error;
        }
      }
    }
  }

  // 8. Merge public services (NOT including private services)
  const services = {
    ...baseServices,
    ...namedServices,
  };

  // 9. Create request context storage and both service & handler contexts
  // Use external storage if provided, otherwise create new storage
  const storage = definition.getExternalStorage
    ? definition.getExternalStorage({ config, options, deps })
    : new RequestContextStorage<TRequestStorage>();

  // Create both contexts using createThisContext (returns { serviceContext, handlerContext })
  const contexts = definition.createThisContext?.({
    config,
    options,
    deps,
    storage,
  });

  const serviceContext = contexts?.serviceContext;
  const handlerContext = contexts?.handlerContext;
  const internalData =
    definition.internalDataFactory?.({
      config,
      options,
      deps,
      linkedFragments: linkedFragmentInstances,
    }) ?? {};

  // 10. Bind services to serviceContext (restricted)
  // Services get the restricted context (for database fragments, this excludes execute methods)
  const boundServices = serviceContext ? bindServicesToContext(services, serviceContext) : services;

  // 11. Resolve routes with bound services
  const context = {
    config,
    deps,
    services: boundServices,
    serviceDeps: serviceImplementations ?? ({} as TServiceDependencies),
  };
  const routes = resolveRouteFactories(context, routesOrFactories) as AnyFragnoRouteConfig[];
  const linkedRoutes = collectLinkedFragmentRoutes(
    linkedFragmentInstances as Record<string, AnyFragnoInstantiatedFragment>,
  );
  const finalRoutes =
    linkedRoutes.length > 0 ? [...routes, ...linkedRoutes] : (routes as AnyFragnoRouteConfig[]);

  // 12. Wrap createRequestStorage to capture context
  const createRequestStorageWithContext = definition.createRequestStorage
    ? () => definition.createRequestStorage!({ config, options, deps })
    : undefined;

  // 13. Create and return fragment instance
  // Pass bound services so they have access to serviceContext via 'this'
  // Handlers get handlerContext which may have more capabilities than serviceContext
  return new FragnoInstantiatedFragment({
    name: definition.name,
    routes: finalRoutes as unknown as RoutesWithInternal<
      FlattenRouteFactories<TRoutesOrFactories>,
      TLinkedFragments
    >,
    deps,
    services: boundServices as BoundServices<TBaseServices & TServices>,
    mountRoute,
    serviceThisContext: serviceContext,
    handlerThisContext: handlerContext,
    storage,
    createRequestStorage: createRequestStorageWithContext,
    options,
    linkedFragments: linkedFragmentInstances,
    internalData: internalData as Record<string, unknown>,
  });
}

/**
 * Interface that defines the public API for a fragment instantiation builder.
 * Used to ensure consistency between real implementations and stubs.
 */
interface IFragmentInstantiationBuilder {
  /**
   * Get the fragment definition
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get definition(): any;

  /**
   * Get the configured routes
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get routes(): any;

  /**
   * Get the configuration
   */
  get config(): unknown;

  /**
   * Get the options
   */
  get options(): unknown;

  /**
   * Set the configuration for the fragment
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withConfig(config: any): unknown;

  /**
   * Set the routes for the fragment
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withRoutes(routes: any): unknown;

  /**
   * Set the options for the fragment (e.g., mountRoute, databaseAdapter)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withOptions(options: any): unknown;

  /**
   * Provide implementations for services that this fragment uses
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withServices(services: any): unknown;

  /**
   * Build and return the instantiated fragment
   */
  build(): IFragnoInstantiatedFragment;
}

/**
 * Interface that defines the public API for an instantiated fragment.
 * Used to ensure consistency between real implementations and stubs.
 */
interface IFragnoInstantiatedFragment {
  readonly [instantiatedFragmentFakeSymbol]: typeof instantiatedFragmentFakeSymbol;

  get name(): string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get routes(): any;
  get services(): Record<string, unknown>;
  get mountRoute(): string;
  get $internal(): {
    deps: unknown;
    options: unknown;
    linkedFragments: unknown;
  } & Record<string, unknown>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withMiddleware(handler: any): this;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inContext<T>(callback: any): T;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inContext<T>(callback: any): Promise<T>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handlersFor(framework: FullstackFrameworks): any;

  handler(req: Request): Promise<Response>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  callRoute(method: HTTPMethod, path: string, inputOptions?: any): Promise<any>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  callRouteRaw(method: HTTPMethod, path: string, inputOptions?: any): Promise<Response>;
}

/**
 * Fluent builder for instantiating fragments.
 * Provides a type-safe API for configuring and building fragment instances.
 */
export class FragmentInstantiationBuilder<
  TConfig,
  TOptions extends FragnoPublicConfig,
  TDeps,
  TBaseServices extends Record<string, unknown>,
  TServices extends Record<string, unknown>,
  TServiceDependencies,
  TPrivateServices extends Record<string, unknown>,
  TServiceThisContext extends RequestThisContext,
  THandlerThisContext extends RequestThisContext,
  TRequestStorage,
  TRoutesOrFactories extends readonly AnyRouteOrFactory[],
  TLinkedFragments extends Record<string, AnyFragnoInstantiatedFragment>,
> implements IFragmentInstantiationBuilder
{
  #definition: FragmentDefinition<
    TConfig,
    TOptions,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    TPrivateServices,
    TServiceThisContext,
    THandlerThisContext,
    TRequestStorage,
    TLinkedFragments
  >;
  #config?: TConfig;
  #routes?: TRoutesOrFactories;
  #options?: TOptions;
  #services?: TServiceDependencies;

  constructor(
    definition: FragmentDefinition<
      TConfig,
      TOptions,
      TDeps,
      TBaseServices,
      TServices,
      TServiceDependencies,
      TPrivateServices,
      TServiceThisContext,
      THandlerThisContext,
      TRequestStorage,
      TLinkedFragments
    >,
    routes?: TRoutesOrFactories,
  ) {
    this.#definition = definition;
    this.#routes = routes;
  }

  /**
   * Get the fragment definition
   */
  get definition(): FragmentDefinition<
    TConfig,
    TOptions,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    TPrivateServices,
    TServiceThisContext,
    THandlerThisContext,
    TRequestStorage,
    TLinkedFragments
  > {
    return this.#definition;
  }

  /**
   * Get the configured routes
   */
  get routes(): TRoutesOrFactories {
    return this.#routes ?? ([] as const as unknown as TRoutesOrFactories);
  }

  /**
   * Get the configuration
   */
  get config(): TConfig | undefined {
    return this.#config;
  }

  /**
   * Get the options
   */
  get options(): TOptions | undefined {
    return this.#options;
  }

  /**
   * Set the configuration for the fragment
   */
  withConfig(config: TConfig): this {
    this.#config = config;
    return this;
  }

  /**
   * Set the routes for the fragment
   */
  withRoutes<const TNewRoutes extends readonly AnyRouteOrFactory[]>(
    routes: TNewRoutes,
  ): FragmentInstantiationBuilder<
    TConfig,
    TOptions,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    TPrivateServices,
    TServiceThisContext,
    THandlerThisContext,
    TRequestStorage,
    TNewRoutes,
    TLinkedFragments
  > {
    const newBuilder = new FragmentInstantiationBuilder(this.#definition, routes);
    // Preserve config, options, and services from the current instance
    newBuilder.#config = this.#config;
    newBuilder.#options = this.#options;
    newBuilder.#services = this.#services;
    return newBuilder;
  }

  /**
   * Set the options for the fragment (e.g., mountRoute, databaseAdapter)
   */
  withOptions(options: TOptions): this {
    this.#options = options;
    return this;
  }

  /**
   * Provide implementations for services that this fragment uses
   */
  withServices(services: TServiceDependencies): this {
    this.#services = services;
    return this;
  }

  /**
   * Build and return the instantiated fragment
   */
  build(): FragnoInstantiatedFragment<
    RoutesWithInternal<FlattenRouteFactories<TRoutesOrFactories>, TLinkedFragments>,
    TDeps,
    BoundServices<TBaseServices & TServices>,
    TServiceThisContext,
    THandlerThisContext,
    TRequestStorage,
    TOptions,
    TLinkedFragments
  > {
    // This variable is set by the frango-cli when extracting database schemas
    const dryRun = process.env["FRAGNO_INIT_DRY_RUN"] === "true";

    return instantiateFragment(
      this.#definition,
      this.#config ?? ({} as TConfig),
      this.#routes ?? ([] as const as unknown as TRoutesOrFactories),
      this.#options ?? ({} as TOptions),
      this.#services,
      { dryRun },
    );
  }
}

/**
 * Create a fluent builder for instantiating a fragment.
 *
 * @example
 * ```ts
 * const fragment = instantiate(myFragmentDefinition)
 *   .withConfig({ apiKey: "key" })
 *   .withRoutes([route1, route2])
 *   .withOptions({ mountRoute: "/api" })
 *   .build();
 * ```
 */
export function instantiate<
  TConfig,
  TOptions extends FragnoPublicConfig,
  TDeps,
  TBaseServices extends Record<string, unknown>,
  TServices extends Record<string, unknown>,
  TServiceDependencies,
  TPrivateServices extends Record<string, unknown>,
  TServiceThisContext extends RequestThisContext,
  THandlerThisContext extends RequestThisContext,
  TRequestStorage,
  TLinkedFragments extends Record<string, AnyFragnoInstantiatedFragment>,
>(
  definition: FragmentDefinition<
    TConfig,
    TOptions,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    TPrivateServices,
    TServiceThisContext,
    THandlerThisContext,
    TRequestStorage,
    TLinkedFragments
  >,
): FragmentInstantiationBuilder<
  TConfig,
  TOptions,
  TDeps,
  TBaseServices,
  TServices,
  TServiceDependencies,
  TPrivateServices,
  TServiceThisContext,
  THandlerThisContext,
  TRequestStorage,
  readonly [],
  TLinkedFragments
> {
  return new FragmentInstantiationBuilder(definition);
}

// Export interfaces for stub implementations
export type { IFragmentInstantiationBuilder, IFragnoInstantiatedFragment };
