import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { ExtractRouteByPath, ExtractRoutePath } from "../client/client";
import type { InferOrUnknown } from "../util/types-util";
import type { HTTPMethod } from "./api";
import type { FragnoResponse } from "./fragno-response";
import { parseFragnoResponse } from "./fragno-response";
import { buildPath, type ExtractPathParams } from "./internal/path";
import type { AnyFragnoRouteConfig } from "./route";
import type { RouteHandlerInputOptions } from "./route-handler-input-options";

export type RouteCallerConfig = {
  baseUrl: string | URL;
  mountRoute?: string;
  baseHeaders?: HeadersInit;
  fetch: (request: Request) => Promise<Response>;
  redirect?: RequestRedirect;
};

type ArrayBufferViewOfArrayBuffer = ArrayBufferView & { buffer: ArrayBuffer };

type FragmentLike = {
  routes?: readonly AnyFragnoRouteConfig[];
  callRoute?: (...args: never[]) => Promise<unknown>;
};

type RouteCallerPath<
  TRoutes extends readonly AnyFragnoRouteConfig[],
  TMethod extends HTTPMethod,
> = [ExtractRoutePath<TRoutes, TMethod>] extends [never]
  ? string
  : ExtractRoutePath<TRoutes, TMethod>;

type RouteCallerMatch<
  TRoutes extends readonly AnyFragnoRouteConfig[],
  TMethod extends HTTPMethod,
  TPath extends string,
> = [ExtractRouteByPath<TRoutes, TPath, TMethod>] extends [never]
  ? AnyFragnoRouteConfig
  : ExtractRouteByPath<TRoutes, TPath, TMethod>;

export type RouteCallerForFragment<TFragment extends FragmentLike> = TFragment extends {
  routes: infer TRoutes extends readonly AnyFragnoRouteConfig[];
}
  ? <TMethod extends HTTPMethod, TPath extends RouteCallerPath<TRoutes, TMethod>>(
      method: TMethod,
      path: TPath,
      inputOptions?: RouteHandlerInputOptions<
        TPath,
        RouteCallerMatch<TRoutes, TMethod, TPath>["inputSchema"]
      >,
    ) => Promise<
      FragnoResponse<
        InferOrUnknown<NonNullable<RouteCallerMatch<TRoutes, TMethod, TPath>["outputSchema"]>>
      >
    >
  : TFragment extends { callRoute: (...args: never[]) => Promise<unknown> }
    ? TFragment["callRoute"]
    : never;

function isArrayBufferView(value: unknown): value is ArrayBufferViewOfArrayBuffer {
  return ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer;
}

function buildMountedPath(mountRoute: string, pathname: string): string {
  const normalizedMount =
    mountRoute === "/" ? "" : mountRoute.endsWith("/") ? mountRoute.slice(0, -1) : mountRoute;
  const pathPart = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (!normalizedMount) {
    return pathPart;
  }
  const mountPart = normalizedMount.startsWith("/") ? normalizedMount : `/${normalizedMount}`;
  return `${mountPart}${pathPart}`;
}

export function createRouteCaller<TFragment extends FragmentLike>(
  config: RouteCallerConfig,
): RouteCallerForFragment<TFragment> {
  const { baseUrl, fetch } = config;
  const mountRoute = config.mountRoute ?? "";
  const baseHeaders = config.baseHeaders ? new Headers(config.baseHeaders) : undefined;
  const redirect = config.redirect ?? "manual";

  const callRoute = async <TPath extends string>(
    method: HTTPMethod,
    path: TPath,
    inputOptions?: RouteHandlerInputOptions<TPath, StandardSchemaV1 | undefined>,
  ): Promise<FragnoResponse<unknown>> => {
    const headers = baseHeaders ? new Headers(baseHeaders) : new Headers();
    const explicitHeaders = inputOptions?.headers
      ? inputOptions.headers instanceof Headers
        ? inputOptions.headers
        : new Headers(inputOptions.headers)
      : null;

    if (explicitHeaders) {
      for (const [key, value] of explicitHeaders.entries()) {
        headers.set(key, value);
      }
    }

    const hasExplicitContentType = explicitHeaders?.has("content-type") ?? false;

    const searchParams =
      inputOptions?.query instanceof URLSearchParams
        ? new URLSearchParams(inputOptions.query)
        : new URLSearchParams();

    if (inputOptions?.query && !(inputOptions.query instanceof URLSearchParams)) {
      for (const [key, value] of Object.entries(inputOptions.query)) {
        if (value !== undefined) {
          searchParams.set(key, value);
        }
      }
    }

    const pathParams = (inputOptions?.pathParams ?? {}) as ExtractPathParams<TPath>;
    const pathname = buildPath(path, pathParams);
    const url = new URL(buildMountedPath(mountRoute, pathname), baseUrl);
    url.search = searchParams.toString();

    let body: BodyInit | undefined;
    if (inputOptions && "body" in inputOptions) {
      const rawBody = (inputOptions as { body?: unknown }).body;

      if (rawBody instanceof FormData || rawBody instanceof Blob) {
        body = rawBody;
        if (!hasExplicitContentType) {
          headers.delete("content-type");
        }
      } else if (rawBody instanceof ReadableStream) {
        body = rawBody;
        if (!hasExplicitContentType) {
          headers.delete("content-type");
        }
      } else if (rawBody instanceof ArrayBuffer) {
        body = rawBody;
        if (!hasExplicitContentType) {
          headers.delete("content-type");
        }
      } else if (isArrayBufferView(rawBody)) {
        body = rawBody;
        if (!hasExplicitContentType) {
          headers.delete("content-type");
        }
      } else if (rawBody !== undefined) {
        body = JSON.stringify(rawBody);
        if (!hasExplicitContentType) {
          headers.set("content-type", "application/json");
        }
      }
    }

    const response = await fetch(
      new Request(url, {
        method,
        headers,
        body,
        redirect,
      }),
    );

    return parseFragnoResponse(response);
  };

  return callRoute as RouteCallerForFragment<TFragment>;
}
