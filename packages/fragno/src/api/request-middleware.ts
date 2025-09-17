import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ExtractRouteByPath, ExtractRoutePath } from "../client/client";
import type { HTTPMethod } from "./api";
import type { ExtractPathParams } from "./internal/path";
import type { RequestBodyType } from "./request-input-context";
import type { AnyFragnoRouteConfig } from "./route";
import { RequestInputContext } from "./request-input-context";
import { OutputContext, RequestOutputContext } from "./request-output-context";

export type FragnoMiddlewareCallback<
  TRoutes extends readonly AnyFragnoRouteConfig[],
  TDeps,
  TServices extends Record<string, unknown>,
> = (
  inputContext: RequestMiddlewareInputContext<TRoutes>,
  outputContext: RequestMiddlewareOutputContext<TDeps, TServices>,
) => Promise<Response | undefined> | Response | undefined;

export interface RequestMiddlewareOptions {
  path: string;
  method: HTTPMethod;
  pathParams?: Record<string, string>;
  searchParams: URLSearchParams;
  body: RequestBodyType;
  request: Request;
}

export class RequestMiddlewareOutputContext<
  const TDeps,
  const TServices extends Record<string, unknown>,
> extends OutputContext<unknown, string> {
  readonly #deps: TDeps;
  readonly #services: TServices;

  constructor(deps: TDeps, services: TServices) {
    super();
    this.#deps = deps;
    this.#services = services;
  }

  get deps(): TDeps {
    return this.#deps;
  }

  get services(): TServices {
    return this.#services;
  }
}

export class RequestMiddlewareInputContext<const TRoutes extends readonly AnyFragnoRouteConfig[]> {
  readonly #options: RequestMiddlewareOptions;
  readonly #route: TRoutes[number];

  constructor(routes: TRoutes, options: RequestMiddlewareOptions) {
    this.#options = options;

    const route = routes.find(
      (route) => route.path === options.path && route.method === options.method,
    );

    if (!route) {
      throw new Error(`Route not found: ${options.path} ${options.method}`);
    }

    this.#route = route;
  }

  get path(): string {
    return this.#options.path;
  }

  get method(): HTTPMethod {
    return this.#options.method;
  }

  get pathParams(): Record<string, string> {
    return this.#options.pathParams ?? {};
  }

  get queryParams(): URLSearchParams {
    return this.#options.searchParams;
  }

  get inputSchema(): StandardSchemaV1 | undefined {
    return this.#route.inputSchema;
  }

  get outputSchema(): StandardSchemaV1 | undefined {
    return this.#route.outputSchema;
  }

  // Defined as a field so that `this` reference stays in tact when destructuring
  ifMatchesRoute = async <
    const TMethod extends HTTPMethod,
    const TPath extends ExtractRoutePath<TRoutes>,
    const TRoute extends ExtractRouteByPath<TRoutes, TPath, TMethod> = ExtractRouteByPath<
      TRoutes,
      TPath,
      TMethod
    >,
  >(
    method: TMethod,
    path: TPath,
    handler: (
      ...args: Parameters<TRoute["handler"]>
    ) => Promise<Response> | Promise<undefined> | Promise<void> | Response | undefined | void,
  ): Promise<Response | undefined> => {
    if (this.path !== path || this.method !== method) {
      return undefined;
    }

    // TODO(Wilco): We should support reading/modifying headers here.
    const inputContext = await RequestInputContext.fromRequest({
      request: this.#options.request,
      method: this.#options.method,
      path: path,
      pathParams: this.pathParams as ExtractPathParams<TPath>,
      inputSchema: this.#route.inputSchema,
    });

    const outputContext = new RequestOutputContext(this.#route.outputSchema);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (handler as any)(inputContext, outputContext);
  };
}
