import { assert, beforeEach, describe, expect, test, vi } from "vitest";

import type { ServerInstrumentation } from "react-router";

const { enterSpan, spans } = vi.hoisted(() => {
  const spans: Array<{
    name: string;
    attributes: Array<[string, boolean | number | string | undefined]>;
  }> = [];
  const enterSpan = vi.fn((name: string, callback: (span: unknown) => unknown) => {
    const attributes: Array<[string, boolean | number | string | undefined]> = [];
    spans.push({ name, attributes });
    return callback({
      setAttribute: (key: string, value?: boolean | number | string) => {
        attributes.push([key, value]);
      },
    });
  });
  return { enterSpan, spans };
});

vi.mock("cloudflare:workers", () => ({ tracing: { enterSpan } }));

import { cloudflareReactRouterServerInstrumentation } from "./cloudflare-react-router-instrumentation";

type InstrumentableRequestHandler = Parameters<NonNullable<ServerInstrumentation["handler"]>>[0];
type RequestHandlerInstrumentations = Parameters<InstrumentableRequestHandler["instrument"]>[0];
type InstrumentableRoute = Parameters<NonNullable<ServerInstrumentation["route"]>>[0];
type RouteInstrumentations = Parameters<InstrumentableRoute["instrument"]>[0];

function registerRequestHandlerInstrumentation(): RequestHandlerInstrumentations {
  let registered: RequestHandlerInstrumentations | undefined;
  cloudflareReactRouterServerInstrumentation.handler?.({
    instrument(instrumentations) {
      registered = instrumentations;
    },
  });
  assert(registered);
  return registered;
}

function registerRouteInstrumentation(routeId: string): RouteInstrumentations {
  let registered: RouteInstrumentations | undefined;
  cloudflareReactRouterServerInstrumentation.route?.({
    id: routeId,
    index: false,
    path: "projects/:projectId",
    instrument(instrumentations) {
      registered = instrumentations;
    },
  });
  assert(registered);
  return registered;
}

const requestInfo = {
  request: {
    method: "GET",
    url: "https://backoffice.example/projects/123?token=secret",
    headers: { get: vi.fn(() => null) },
  },
  context: undefined,
};

const routeInfo = {
  request: requestInfo.request,
  url: new URL("https://backoffice.example/projects/123"),
  pattern: "/projects/:projectId",
  params: { projectId: "123" },
  context: { get: vi.fn() } as never,
};

describe("cloudflareReactRouterServerInstrumentation", () => {
  beforeEach(() => {
    spans.length = 0;
    enterSpan.mockReset();
    enterSpan.mockImplementation((name: string, callback: (span: unknown) => unknown) => {
      const attributes: Array<[string, boolean | number | string | undefined]> = [];
      spans.push({ name, attributes });
      return callback({
        setAttribute: (key: string, value?: boolean | number | string) => {
          attributes.push([key, value]);
        },
      });
    });
  });

  test("instruments requests with normalized route and response attributes", async () => {
    const instrumentation = registerRequestHandlerInstrumentation();
    const execute = vi.fn(async () => ({
      status: "success" as const,
      error: undefined,
      statusCode: 200,
      meta: {
        url: new URL("https://backoffice.example/projects/123"),
        pattern: "/projects/:projectId",
        params: { projectId: "123" },
      },
    }));

    await instrumentation.request?.(execute, requestInfo);

    expect(execute).toHaveBeenCalledOnce();
    expect(spans).toEqual([
      {
        name: "react_router.request",
        attributes: [
          ["http.request.method", "GET"],
          ["url.path", "/projects/123"],
          ["react_router.result.status", "success"],
          ["http.response.status_code", 200],
          ["http.route", "/projects/:projectId"],
        ],
      },
    ]);
  });

  test("instruments middleware, loaders, and actions with stable route spans", async () => {
    const instrumentation = registerRouteInstrumentation("routes/projects.$projectId");
    const success = vi.fn(async () => ({ status: "success" as const, error: undefined }));
    const failure = vi.fn(async () => ({
      status: "error" as const,
      error: new TypeError("project failed"),
    }));

    await instrumentation.middleware?.(success, routeInfo);
    await instrumentation.loader?.(success, routeInfo);
    await instrumentation.action?.(failure, {
      ...routeInfo,
      request: { ...routeInfo.request, method: "POST" },
    });

    expect(spans.map(({ name }) => name)).toEqual([
      "react_router.route.middleware",
      "react_router.route.loader",
      "react_router.route.action",
    ]);
    expect(spans[0]?.attributes).toEqual([
      ["http.request.method", "GET"],
      ["http.route", "/projects/:projectId"],
      ["react_router.route.id", "routes/projects.$projectId"],
      ["react_router.result.status", "success"],
    ]);
    expect(spans[2]?.attributes).toEqual([
      ["http.request.method", "POST"],
      ["http.route", "/projects/:projectId"],
      ["react_router.route.id", "routes/projects.$projectId"],
      ["react_router.result.status", "error"],
      ["error.type", "TypeError"],
    ]);
    expect(success).toHaveBeenCalledTimes(2);
    expect(failure).toHaveBeenCalledOnce();
  });

  test("executes the React Router handler when Cloudflare skips the span callback", async () => {
    enterSpan.mockReturnValue(undefined);
    const instrumentation = registerRequestHandlerInstrumentation();
    const execute = vi.fn(async () => ({
      status: "success" as const,
      error: undefined,
      statusCode: 204,
      meta: undefined,
    }));

    await instrumentation.request?.(execute, requestInfo);

    expect(execute).toHaveBeenCalledOnce();
  });
});
