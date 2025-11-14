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
import type { NewFragmentDefinition } from "./fragment-definition-builder";
import type { FragnoPublicConfig } from "./fragment-instantiation";
import { RequestContextStorage } from "./request-context-storage";
import { bindServicesToContext, type BoundServices } from "./bind-services";

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

type FullstackFrameworks = keyof HandlersByFramework;

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

// Not actually a symbol, since we might be dealing with multiple instances of this code.
export const instantiatedFragmentFakeSymbol = "$fragno-instantiated-fragment" as const;

/**
 * New instantiated fragment class with encapsulated state.
 * Provides the same public API as the old FragnoInstantiatedFragment but with better encapsulation.
 */
export class NewFragnoInstantiatedFragment<
  TRoutes extends readonly AnyFragnoRouteConfig[],
  TDeps,
  TServices extends Record<string, unknown>,
  TThisContext extends RequestThisContext,
  TRequestStorage = {},
> {
  readonly [instantiatedFragmentFakeSymbol] = instantiatedFragmentFakeSymbol;

  // Private fields
  #name: string;
  #routes: TRoutes;
  #deps: TDeps;
  #services: TServices;
  #mountRoute: string;
  #router: ReturnType<typeof createRouter>;
  #middlewareHandler?: FragnoMiddlewareCallback<TRoutes, TDeps, TServices>;
  #thisContext?: TThisContext;
  #contextStorage: RequestContextStorage<TRequestStorage>;
  #createRequestStorage?: () => TRequestStorage;

  constructor(params: {
    name: string;
    routes: TRoutes;
    deps: TDeps;
    services: TServices;
    mountRoute: string;
    thisContext?: TThisContext;
    storage: RequestContextStorage<TRequestStorage>;
    createRequestStorage?: () => TRequestStorage;
  }) {
    this.#name = params.name;
    this.#routes = params.routes;
    this.#deps = params.deps;
    this.#services = params.services;
    this.#mountRoute = params.mountRoute;
    this.#thisContext = params.thisContext;
    this.#contextStorage = params.storage;
    this.#createRequestStorage = params.createRequestStorage;

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
    if (!this.#thisContext) {
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
   * to access the `this` context. Useful for calling services outside of route handlers
   * (e.g., in tests, background jobs).
   *
   * @param callback - The callback to run within the context
   *
   * @example
   * ```typescript
   * const result = await fragment.inContext(() => {
   *   return fragment.services.someMethod();
   * });
   * ```
   */
  inContext<T>(callback: () => T): T;
  inContext<T>(callback: () => Promise<T>): Promise<T>;
  inContext<T>(callback: () => T | Promise<T>): T | Promise<T> {
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

    // Parse request body
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

    // Execute middleware and handler
    const executeRequest = async (): Promise<Response> => {
      // Middleware execution (if present)
      if (this.#middlewareHandler) {
        const middlewareResult = await this.#executeMiddleware(req, route, requestState);
        if (middlewareResult !== undefined) {
          return middlewareResult;
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

    // Convert headers to Headers if needed
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

    // Construct RequestOutputContext
    const outputContext = new RequestOutputContext(route.outputSchema);

    // Execute handler
    const executeHandler = async (): Promise<Response> => {
      try {
        const thisContext = this.#thisContext ?? ({} as RequestThisContext);
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
    if (!this.#middlewareHandler || !route) {
      return undefined;
    }

    const { path } = route.data as AnyFragnoRouteConfig;

    const middlewareInputContext = new RequestMiddlewareInputContext(this.#routes, {
      method: req.method as HTTPMethod,
      path,
      request: req,
      state: requestState,
    });

    const middlewareOutputContext = new RequestMiddlewareOutputContext(this.#deps, this.#services);

    try {
      const middlewareResult = await this.#middlewareHandler(
        middlewareInputContext,
        middlewareOutputContext,
      );
      if (middlewareResult !== undefined) {
        return middlewareResult;
      }
    } catch (error) {
      console.error("Error in middleware", error);

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

    const outputContext = new RequestOutputContext(outputSchema);

    try {
      // Note: We don't call .run() here because the storage should already be initialized
      // by the handler() method or inContext() method before this point
      if (this.#thisContext) {
        const result = await handler.call(this.#thisContext!, inputContext, outputContext);
        return result;
      } else {
        // No request context - use empty context
        const thisContext = {} as RequestThisContext;
        const result = await handler.call(thisContext, inputContext, outputContext);
        return result;
      }
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
 * Core instantiation function that creates a fragment instance from a definition.
 * This function validates dependencies, calls all callbacks, and wires everything together.
 */
export function instantiateNewFragment<
  const TConfig,
  const TOptions extends FragnoPublicConfig,
  const TDeps,
  const TBaseServices extends Record<string, unknown>,
  const TServices extends Record<string, unknown>,
  const TServiceDependencies,
  const TThisContext extends RequestThisContext,
  const TRequestStorage,
  const TRoutesOrFactories extends readonly AnyRouteOrFactory[],
>(
  definition: NewFragmentDefinition<
    TConfig,
    TOptions,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    TThisContext,
    TRequestStorage
  >,
  config: TConfig,
  routesOrFactories: TRoutesOrFactories,
  options: TOptions,
  serviceImplementations?: TServiceDependencies,
): NewFragnoInstantiatedFragment<
  FlattenRouteFactories<TRoutesOrFactories>,
  TDeps,
  BoundServices<TBaseServices & TServices>,
  TThisContext,
  TRequestStorage
> {
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
  const deps = definition.dependencies?.({ config, options }) ?? ({} as TDeps);

  // Identity function for service definition (used to set 'this' context)
  const defineService = <T>(services: T & ThisType<TThisContext>): T => services;

  // 3. Call baseServices callback
  const baseServices =
    definition.baseServices?.({
      config,
      options,
      deps,
      serviceDeps: (serviceImplementations ?? {}) as TServiceDependencies,
      defineService,
    }) ?? ({} as TBaseServices);

  // 4. Call namedServices factories
  const namedServices = {} as TServices;
  if (definition.namedServices) {
    for (const [serviceName, factory] of Object.entries(definition.namedServices)) {
      const serviceFactory = factory as (context: {
        config: TConfig;
        options: TOptions;
        deps: TDeps;
        serviceDeps: TServiceDependencies;
        defineService: <T>(svc: T & ThisType<TThisContext>) => T;
      }) => unknown;
      (namedServices as Record<string, unknown>)[serviceName] = serviceFactory({
        config,
        options,
        deps,
        serviceDeps: (serviceImplementations ?? {}) as TServiceDependencies,
        defineService,
      });
    }
  }

  // 5. Merge all services
  const services = {
    ...baseServices,
    ...namedServices,
  };

  // 6. Create request context storage and thisContext if provided
  const storage = new RequestContextStorage<TRequestStorage>();
  const thisContext = definition.createRequestContext?.({
    config,
    options,
    deps,
    storage,
  });

  // 7. Bind services to thisContext
  // The thisContext contains getters/methods that read from storage for per-request isolation
  const boundServices = thisContext ? bindServicesToContext(services, thisContext) : services;

  // 8. Resolve routes with bound services
  const context = { config, deps, services: boundServices };
  const routes = resolveRouteFactories(context, routesOrFactories);

  // 9. Calculate mount route
  const mountRoute = getMountRoute({
    name: definition.name,
    mountRoute: options.mountRoute,
  });

  // 10. Wrap createRequestStorage to capture context
  const createRequestStorageWithContext = definition.createRequestStorage
    ? () => definition.createRequestStorage!({ config, options, deps })
    : undefined;

  // 11. Create and return fragment instance
  // Pass bound services so they have access to thisContext via 'this'
  // Safe cast: boundServices is either BoundServices<T> or T (when no thisContext).
  // Both are compatible at runtime, and the return type reflects BoundServices<T>.
  return new NewFragnoInstantiatedFragment({
    name: definition.name,
    routes,
    deps,
    services: boundServices as BoundServices<TBaseServices & TServices>,
    mountRoute,
    thisContext,
    storage,
    createRequestStorage: createRequestStorageWithContext,
  });
}

/**
 * Fluent builder for instantiating fragments.
 * Provides a type-safe API for configuring and building fragment instances.
 */
export class NewFragmentInstantiationBuilder<
  TConfig,
  TOptions extends FragnoPublicConfig,
  TDeps,
  TBaseServices extends Record<string, unknown>,
  TServices extends Record<string, unknown>,
  TServiceDependencies,
  TThisContext extends RequestThisContext,
  TRequestStorage,
  TRoutesOrFactories extends readonly AnyRouteOrFactory[],
> {
  #definition: NewFragmentDefinition<
    TConfig,
    TOptions,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    TThisContext,
    TRequestStorage
  >;
  #config?: TConfig;
  #routes?: TRoutesOrFactories;
  #options?: TOptions;
  #services?: TServiceDependencies;

  constructor(
    definition: NewFragmentDefinition<
      TConfig,
      TOptions,
      TDeps,
      TBaseServices,
      TServices,
      TServiceDependencies,
      TThisContext,
      TRequestStorage
    >,
    routes?: TRoutesOrFactories,
  ) {
    this.#definition = definition;
    this.#routes = routes;
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
  ): NewFragmentInstantiationBuilder<
    TConfig,
    TOptions,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    TThisContext,
    TRequestStorage,
    TNewRoutes
  > {
    return new NewFragmentInstantiationBuilder(this.#definition, routes);
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
  build(): NewFragnoInstantiatedFragment<
    FlattenRouteFactories<TRoutesOrFactories>,
    TDeps,
    BoundServices<TBaseServices & TServices>,
    TThisContext,
    TRequestStorage
  > {
    return instantiateNewFragment(
      this.#definition,
      this.#config ?? ({} as TConfig),
      this.#routes ?? ([] as const as unknown as TRoutesOrFactories),
      this.#options ?? ({} as TOptions),
      this.#services,
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
  TThisContext extends RequestThisContext,
  TRequestStorage,
>(
  definition: NewFragmentDefinition<
    TConfig,
    TOptions,
    TDeps,
    TBaseServices,
    TServices,
    TServiceDependencies,
    TThisContext,
    TRequestStorage
  >,
): NewFragmentInstantiationBuilder<
  TConfig,
  TOptions,
  TDeps,
  TBaseServices,
  TServices,
  TServiceDependencies,
  TThisContext,
  TRequestStorage,
  readonly []
> {
  return new NewFragmentInstantiationBuilder(definition);
}
