import { defineRoutes } from "@fragno-dev/core";

import { cloudflareFragmentDefinition } from "../definition";
import {
  browserRunSessionCloseResultSchema,
  browserRunSessionCreateInputSchema,
  browserRunSessionCreateResultSchema,
  browserRunSessionListInputSchema,
  browserRunSessionListQueryParameterNames,
  browserRunSessionListResultSchema,
  browserRunSessionResultSchema,
  browserRunTargetActivateResultSchema,
  browserRunTargetCloseResultSchema,
  browserRunTargetCreateInputSchema,
  browserRunTargetCreateResultSchema,
  browserRunTargetListResultSchema,
  browserRunTargetResultSchema,
} from "./session-contracts";

const optionalIntegerQueryParameter = (query: URLSearchParams, name: string) => {
  const value = query.get(name);
  return value === null ? undefined : Number(value);
};

export const browserRunSessionRoutesFactory = defineRoutes(cloudflareFragmentDefinition).create(
  ({ services, defineRoute }) => [
    defineRoute({
      method: "POST",
      path: "/browser-run/sessions",
      inputSchema: browserRunSessionCreateInputSchema,
      outputSchema: browserRunSessionCreateResultSchema,
      handler: async function ({ input }, { json }) {
        return json(await services.browserRunSessions.create(await input.valid()));
      },
    }),
    defineRoute({
      method: "GET",
      path: "/browser-run/sessions",
      queryParameters: browserRunSessionListQueryParameterNames,
      outputSchema: browserRunSessionListResultSchema,
      errorCodes: ["INVALID_BROWSER_SESSION_QUERY"],
      handler: async function ({ query }, { json, error }) {
        const parsedInput = browserRunSessionListInputSchema.safeParse({
          limit: optionalIntegerQueryParameter(query, "limit"),
          offset: optionalIntegerQueryParameter(query, "offset"),
        });

        if (!parsedInput.success) {
          return error(
            {
              code: "INVALID_BROWSER_SESSION_QUERY",
              message: "Browser session limit and offset must be valid integers.",
            },
            400,
          );
        }

        return json(await services.browserRunSessions.list(parsedInput.data));
      },
    }),
    defineRoute({
      method: "GET",
      path: "/browser-run/sessions/:sessionId",
      outputSchema: browserRunSessionResultSchema,
      errorCodes: ["BROWSER_SESSION_NOT_FOUND"],
      handler: async function ({ pathParams }, { json, error }) {
        const session = await services.browserRunSessions.get(pathParams.sessionId);

        if (!session) {
          return error(
            {
              code: "BROWSER_SESSION_NOT_FOUND",
              message: `Browser session '${pathParams.sessionId}' was not found.`,
            },
            404,
          );
        }

        return json(session);
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/browser-run/sessions/:sessionId",
      outputSchema: browserRunSessionCloseResultSchema,
      handler: async function ({ pathParams }, { json }) {
        return json(await services.browserRunSessions.close(pathParams.sessionId));
      },
    }),
    defineRoute({
      method: "POST",
      path: "/browser-run/sessions/:sessionId/targets",
      inputSchema: browserRunTargetCreateInputSchema,
      outputSchema: browserRunTargetCreateResultSchema,
      handler: async function ({ input, pathParams }, { json }) {
        return json(
          await services.browserRunSessions.createTarget(pathParams.sessionId, await input.valid()),
        );
      },
    }),
    defineRoute({
      method: "GET",
      path: "/browser-run/sessions/:sessionId/targets",
      outputSchema: browserRunTargetListResultSchema,
      handler: async function ({ pathParams }, { json }) {
        return json(await services.browserRunSessions.listTargets(pathParams.sessionId));
      },
    }),
    defineRoute({
      method: "GET",
      path: "/browser-run/sessions/:sessionId/targets/:targetId",
      outputSchema: browserRunTargetResultSchema,
      handler: async function ({ pathParams }, { json }) {
        return json(
          await services.browserRunSessions.getTarget(pathParams.sessionId, pathParams.targetId),
        );
      },
    }),
    defineRoute({
      method: "POST",
      path: "/browser-run/sessions/:sessionId/targets/:targetId/activate",
      outputSchema: browserRunTargetActivateResultSchema,
      handler: async function ({ pathParams }, { json }) {
        return json(
          await services.browserRunSessions.activateTarget(
            pathParams.sessionId,
            pathParams.targetId,
          ),
        );
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/browser-run/sessions/:sessionId/targets/:targetId",
      outputSchema: browserRunTargetCloseResultSchema,
      handler: async function ({ pathParams }, { json }) {
        return json(
          await services.browserRunSessions.closeTarget(pathParams.sessionId, pathParams.targetId),
        );
      },
    }),
  ],
);
