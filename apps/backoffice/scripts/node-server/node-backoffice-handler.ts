import type express from "express";
import type { ServerBuild } from "react-router";

import { getRequestListener } from "@hono/node-server";
import { createRequestHandler } from "@react-router/express";

import { isBackofficeApiPath } from "../../app/backoffice-api/api-path";
import { backofficeApiRouter } from "../../app/backoffice-api/backoffice-api-router";
import { BackofficeKernel } from "../../app/backoffice-runtime/kernel";
import type { LocalBackofficeRuntime } from "../../app/backoffice-runtime/node/local-runtime";
import { createBackofficeRouterContextProvider } from "../../app/worker-runtime/router-context-provider.server";

/**
 * Serves Backoffice from a local runtime: its API, and the React Router app. The Node server and
 * the scenario server put their own assets and middleware in front of it.
 */
export function mountBackofficeHandler(
  app: express.Express,
  input: {
    runtime: Pick<LocalBackofficeRuntime, "services" | "env">;
    build: ServerBuild | (() => Promise<ServerBuild>);
    mode: "production" | "development";
  },
): void {
  const { runtime } = input;
  const kernel = new BackofficeKernel(runtime.services);
  const backofficeApiListener = getRequestListener(
    async (request, { incoming }) => {
      // Use the URL React Router sees: Express applies the trusted proxy's protocol and host, and
      // credential verification depends on the public origin.
      const { protocol, host, originalUrl } = incoming as express.Request;
      return await backofficeApiRouter.fetch(
        new Request(new URL(`${protocol}://${host}${originalUrl}`), {
          method: request.method,
          headers: request.headers,
          // API bodies are small JSON documents, so buffering avoids streaming-body plumbing.
          body:
            request.method === "GET" || request.method === "HEAD"
              ? null
              : await request.arrayBuffer(),
          signal: request.signal,
        }),
        { runtime: runtime.services, kernel },
      );
      // Hono would replace the global Response with a subclass that `Response.json()` does not
      // return, and React Router checks its handlers' results are `instanceof Response`.
    },
    { overrideGlobalObjects: false },
  );
  app.use((request, response, next) => {
    if (isBackofficeApiPath(request.path)) {
      void backofficeApiListener(request, response);
      return;
    }
    next();
  });
  app.use(
    createRequestHandler({
      build: input.build,
      mode: input.mode,
      getLoadContext(request, response) {
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (Array.isArray(value)) {
            for (const entry of value) {
              headers.append(name, entry);
            }
          } else if (value !== undefined) {
            headers.set(name, value);
          }
        }
        const controller = new AbortController();
        response.once("close", () => {
          if (!response.writableFinished) {
            controller.abort();
          }
        });
        // The adapter owns the request body; request state only needs URL, headers, and
        // cancellation.
        const contextRequest = new Request(
          new URL(`${request.protocol}://${request.host}${request.originalUrl}`),
          { method: request.method, headers, signal: controller.signal },
        );
        return createBackofficeRouterContextProvider(contextRequest, {
          runtime: runtime.services,
          kernel,
          env: runtime.env as unknown as CloudflareEnv,
          ctx: {
            waitUntil: (promise: Promise<unknown>) => void promise.catch(console.error),
          } as ExecutionContext,
        });
      },
    }),
  );
}
