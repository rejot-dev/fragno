import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";

import type {
  NodeObjectRuntimeHostApplication,
  NodeObjectRuntimeHostConnection,
} from "@fragno-private/backoffice-node-runtime/node-object-runtime-host";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createRequestHandler, type ServerBuild } from "react-router";

import { isSpanContextValid } from "@opentelemetry/api";

import type { BackofficeRuntimeEnv } from "../../app/backoffice-runtime/backoffice-runtime-env";
import { BackofficeKernel } from "../../app/backoffice-runtime/kernel";
import { runNodeOpenTelemetrySpan } from "../../app/backoffice-runtime/node/node-opentelemetry-span";
import { forwardRequestOwnedResponse } from "../../app/backoffice-runtime/request-owned-response";
import type { BackofficeRuntimeServices } from "../../app/backoffice-runtime/runtime-services";
import { createBackofficeRouterContextProvider } from "../../app/worker-runtime/router-context-provider.server";
import { logNodeBackofficeRequestCompletion } from "../server/node-request-observability";
import { createGraftBackofficeRequestNormalizer } from "./graft-server-proxy";

/** Serves the existing React Router build inside the host's request output gate. */
export function createNodeGraftBackofficeApplication(options: {
  serverBuild: ServerBuild;
  services: BackofficeRuntimeServices;
  env: BackofficeRuntimeEnv;
  staticDirectory: string;
  publicBaseUrl: string;
  trustedProxy: string;
  development: boolean;
}): NodeObjectRuntimeHostApplication {
  const router = createRequestHandler(options.serverBuild, "production");
  const kernel = new BackofficeKernel(options.services);
  const normalize = createGraftBackofficeRequestNormalizer(
    options.publicBaseUrl,
    options.trustedProxy,
  );
  const app = new Hono<{
    Bindings: NodeObjectRuntimeHostConnection;
    Variables: { normalizedRequest: Request };
  }>();
  app.get("/healthz", (context) => context.text("ok\n"));
  app.use("*", async (context, next) => {
    const request = normalize(context.req.raw, context.env);
    if (request instanceof Response) {
      return request;
    }
    // The normalized request includes trusted scheme handling and strips forwarded host spoofing.
    context.set("normalizedRequest", request);
    await next();
    return context.res;
  });
  if (options.development) {
    const assetsUrl = new URL(
      "../assets/",
      import.meta.resolve("@tanstack/browser-db-sqlite-persistence"),
    );
    for (const name of readdirSync(assetsUrl)) {
      if (name.startsWith("opfs-worker-") && name.endsWith(".js.map")) {
        app.get(
          `/assets/${name}`,
          async () =>
            new Response(await readFile(new URL(name, assetsUrl)), {
              headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
            }),
        );
      }
    }
  }
  app.use(
    "/assets/*",
    createNodeBackofficeStaticMiddleware(
      options.staticDirectory,
      "public, max-age=31536000, immutable",
    ),
  );
  app.use("*", createNodeBackofficeStaticMiddleware(options.staticDirectory, "public, max-age=60"));
  app.all("*", async (context) => {
    const request = context.get("normalizedRequest");
    const background: Promise<unknown>[] = [];
    const loadContext = createBackofficeRouterContextProvider(request, {
      runtime: options.services,
      kernel,
      env: options.env as unknown as CloudflareEnv,
      ctx: {
        waitUntil(promise: Promise<unknown>) {
          background.push(promise);
          void promise.catch(() => {});
        },
      } as ExecutionContext,
    });
    try {
      return forwardRequestOwnedResponse(request, await router(request, loadContext));
    } finally {
      // Host output settlement must include mutations registered by route background work.
      while (background.length > 0) {
        const settled = await Promise.allSettled(background.splice(0));
        for (const result of settled) {
          if (result.status === "rejected") {
            console.error("BACKOFFICE_REQUEST_BACKGROUND_FAILED", result.reason);
          }
        }
      }
    }
  });
  return {
    async fetch(request, connection) {
      return await runNodeOpenTelemetrySpan("backoffice.http.request", async (span) => {
        const requestId = randomUUID();
        const startedAt = performance.now();
        span.setAttribute("backoffice.request_id", requestId);
        const currentSpanContext = span.spanContext();
        const spanContext = isSpanContextValid(currentSpanContext) ? currentSpanContext : null;
        connection.onResponseSettled((outcome, status) => {
          logNodeBackofficeRequestCompletion({
            requestId,
            spanContext,
            startedAt,
            method: request.method,
            path: new URL(request.url).pathname,
            status,
            outcome,
          });
        });
        const response = await app.fetch(request, connection);
        response.headers.set("backoffice-request-id", requestId);
        return response;
      });
    },
    handleFetchFailure(error) {
      console.error("BACKOFFICE_GRAFT_REQUEST_FAILED", error);
      return Response.json({ code: "BACKOFFICE_REQUEST_FAILED" }, { status: 503 });
    },
  };
}

function createNodeBackofficeStaticMiddleware(
  staticDirectory: string,
  cacheControl: string,
): ReturnType<typeof serveStatic> {
  const serve = serveStatic({ root: staticDirectory });
  return async function serveCachedBackofficeStatic(context, next) {
    const response = await serve(context, next);
    if (response instanceof Response) {
      // Native Response snapshots headers before serveStatic's onFound callback can update them.
      response.headers.set("Cache-Control", cacheControl);
    }
    return response;
  };
}
