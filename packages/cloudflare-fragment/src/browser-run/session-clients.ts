import { createClientBuilder, type FragnoPublicClientConfig } from "@fragno-dev/core/client";

import { cloudflareFragmentDefinition } from "../definition";
import { browserRunSessionRoutesFactory } from "./session-routes";

export function createBrowserRunSessionClients(fragnoConfig: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(cloudflareFragmentDefinition, fragnoConfig, [
    browserRunSessionRoutesFactory,
  ] as const);

  const browserRunTarget = builder.createHook("/browser-run/sessions/:sessionId/targets/:targetId");

  return {
    useBrowserRunSessions: builder.createHook("/browser-run/sessions"),
    useBrowserRunSession: builder.createHook("/browser-run/sessions/:sessionId"),
    useCreateBrowserRunSession: builder.createMutator(
      "POST",
      "/browser-run/sessions",
      (invalidate) => {
        invalidate("GET", "/browser-run/sessions", {});
      },
    ),
    useCloseBrowserRunSession: builder.createMutator(
      "DELETE",
      "/browser-run/sessions/:sessionId",
      (invalidate, params) => {
        invalidate("GET", "/browser-run/sessions", {});
        invalidate("GET", "/browser-run/sessions/:sessionId", {
          pathParams: { sessionId: params.pathParams.sessionId },
        });
      },
    ),
    useBrowserRunTargets: builder.createHook("/browser-run/sessions/:sessionId/targets"),
    useBrowserRunTarget: browserRunTarget,
    fetchBrowserRunTarget: (sessionId: string, targetId: string) =>
      browserRunTarget.query({ path: { sessionId, targetId } }),
    useCreateBrowserRunTarget: builder.createMutator(
      "POST",
      "/browser-run/sessions/:sessionId/targets",
      (invalidate, params) => {
        invalidate("GET", "/browser-run/sessions/:sessionId/targets", {
          pathParams: { sessionId: params.pathParams.sessionId },
        });
      },
    ),
    useActivateBrowserRunTarget: builder.createMutator(
      "POST",
      "/browser-run/sessions/:sessionId/targets/:targetId/activate",
      (invalidate, params) => {
        const pathParams = {
          sessionId: params.pathParams.sessionId,
          targetId: params.pathParams.targetId,
        };
        invalidate("GET", "/browser-run/sessions/:sessionId/targets", {
          pathParams: { sessionId: pathParams.sessionId },
        });
        invalidate("GET", "/browser-run/sessions/:sessionId/targets/:targetId", {
          pathParams,
        });
      },
    ),
    useCloseBrowserRunTarget: builder.createMutator(
      "DELETE",
      "/browser-run/sessions/:sessionId/targets/:targetId",
      (invalidate, params) => {
        const pathParams = {
          sessionId: params.pathParams.sessionId,
          targetId: params.pathParams.targetId,
        };
        invalidate("GET", "/browser-run/sessions/:sessionId/targets", {
          pathParams: { sessionId: pathParams.sessionId },
        });
        invalidate("GET", "/browser-run/sessions/:sessionId/targets/:targetId", {
          pathParams,
        });
      },
    ),
  };
}
