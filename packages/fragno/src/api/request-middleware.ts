import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ExtractRouteByPath, ExtractRoutePath } from "../client/client";
import type { HTTPMethod } from "./api";
import type { ExtractPathParams } from "./internal/path";
import type { AnyFragnoRouteConfig } from "./route";
import { RequestInputContext } from "./request-input-context";
import { OutputContext, RequestOutputContext } from "./request-output-context";
import { MutableRequestState } from "./mutable-request-state";

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
  request: Request;
  state: MutableRequestState;
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
  readonly #state: MutableRequestState;

  constructor(routes: TRoutes, options: RequestMiddlewareOptions) {
    this.#options = options;
    this.#state = options.state;

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
    return this.#state.pathParams;
  }

  get queryParams(): URLSearchParams {
    return this.#state.searchParams;
  }

  get headers(): Headers {
    return this.#state.headers;
  }

  get inputSchema(): StandardSchemaV1 | undefined {
    return this.#route.inputSchema;
  }

  get outputSchema(): StandardSchemaV1 | undefined {
    return this.#route.outputSchema;
  }

  /**
   * Access to the mutable request state.
   * Use this to modify query parameters, path parameters, or request body.
   *
   * @example
   * ```typescript
   * // Modify body
   * requestState.setBody({ modified: true });
   *
   * // Query params are already accessible via queryParams getter
   * // Path params are already accessible via pathParams getter
   * ```
   */
  get requestState(): MutableRequestState {
    return this.#state;
  }

  // Defined as a field so that `this` reference stays in tact when destructuring
  ifMatchesRoute = async <
    const TMethod extends HTTPMethod,
    const TPath extends ExtractRoutePath<TRoutes, TMethod>,
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
    ) => Promise<Response | undefined | void> | Response | undefined | void,
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
      state: this.#state,
    });

    const outputContext = new RequestOutputContext(this.#route.outputSchema);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (handler as any)(inputContext, outputContext);
  };
}
