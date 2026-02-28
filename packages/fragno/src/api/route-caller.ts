import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { HTTPMethod } from "./api";
import type { FragnoResponse } from "./fragno-response";
import { parseFragnoResponse } from "./fragno-response";
import { buildPath, type ExtractPathParams } from "./internal/path";
import type { RouteHandlerInputOptions } from "./route-handler-input-options";

export type RouteCallerConfig = {
  baseUrl: string | URL;
  mountRoute?: string;
  baseHeaders?: HeadersInit;
  fetch: (request: Request) => Promise<Response>;
  redirect?: RequestRedirect;
};

type ArrayBufferViewOfArrayBuffer = ArrayBufferView & { buffer: ArrayBuffer };

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

type FragmentLike = { callRoute: (...args: never[]) => Promise<unknown> };

export function createRouteCaller<TFragment extends FragmentLike>(
  config: RouteCallerConfig,
): TFragment["callRoute"] {
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

    if (inputOptions?.headers) {
      const extra =
        inputOptions.headers instanceof Headers
          ? inputOptions.headers
          : new Headers(inputOptions.headers);
      for (const [key, value] of extra.entries()) {
        headers.set(key, value);
      }
    }

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
      } else if (rawBody instanceof ReadableStream) {
        body = rawBody;
      } else if (rawBody instanceof ArrayBuffer) {
        body = rawBody;
      } else if (isArrayBufferView(rawBody)) {
        body = rawBody;
      } else if (rawBody !== undefined) {
        body = JSON.stringify(rawBody);
        if (!headers.has("content-type")) {
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

  return callRoute as TFragment["callRoute"];
}
