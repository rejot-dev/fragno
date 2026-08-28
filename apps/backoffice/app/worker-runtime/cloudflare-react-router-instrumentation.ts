import { tracing } from "cloudflare:workers";
import type {
  InstrumentationHandlerResult,
  InstrumentationServerHandlerResult,
  ServerInstrumentation,
} from "react-router";

type ReactRouterInstrumentationResult =
  | InstrumentationHandlerResult
  | InstrumentationServerHandlerResult;

type CloudflareSpanAttributes = Readonly<Record<string, boolean | number | string>>;

function setCloudflareSpanAttributes(span: Span, attributes: CloudflareSpanAttributes): void {
  for (const [key, value] of Object.entries(attributes)) {
    span.setAttribute(key, value);
  }
}

function setReactRouterResultAttributes(
  span: Span,
  result: ReactRouterInstrumentationResult,
): void {
  span.setAttribute("react_router.result.status", result.status);
  if (result.error) {
    span.setAttribute("error.type", result.error.name);
  }

  if ("statusCode" in result) {
    span.setAttribute("http.response.status_code", result.statusCode);
  }
  if ("meta" in result && result.meta) {
    span.setAttribute("http.route", result.meta.pattern);
  }
}

async function runCloudflareReactRouterSpan(
  name: string,
  attributes: CloudflareSpanAttributes,
  execute: () => Promise<ReactRouterInstrumentationResult>,
): Promise<void> {
  let enteredSpan = false;
  try {
    const spanExecution = tracing.enterSpan(name, async (span) => {
      enteredSpan = true;
      setCloudflareSpanAttributes(span, attributes);
      const result = await execute();
      setReactRouterResultAttributes(span, result);
    });

    if (enteredSpan) {
      await spanExecution;
      return;
    }
  } catch (error) {
    if (enteredSpan) {
      throw error;
    }
  }

  await execute();
}

/** Instruments React Router requests and server route handlers with stable Cloudflare spans. */
export const cloudflareReactRouterServerInstrumentation: ServerInstrumentation = {
  handler(context) {
    context.instrument({
      request: (execute, { request }) =>
        runCloudflareReactRouterSpan(
          "react_router.request",
          {
            "http.request.method": request.method,
            "url.path": new URL(request.url).pathname,
          },
          execute,
        ),
    });
  },
  route(context) {
    const { id } = context;
    context.instrument({
      middleware: (execute, { request, pattern }) =>
        runCloudflareReactRouterSpan(
          "react_router.route.middleware",
          {
            "http.request.method": request.method,
            "http.route": pattern,
            "react_router.route.id": id,
          },
          execute,
        ),
      loader: (execute, { request, pattern }) =>
        runCloudflareReactRouterSpan(
          "react_router.route.loader",
          {
            "http.request.method": request.method,
            "http.route": pattern,
            "react_router.route.id": id,
          },
          execute,
        ),
      action: (execute, { request, pattern }) =>
        runCloudflareReactRouterSpan(
          "react_router.route.action",
          {
            "http.request.method": request.method,
            "http.route": pattern,
            "react_router.route.id": id,
          },
          execute,
        ),
    });
  },
};
