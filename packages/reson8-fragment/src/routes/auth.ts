import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import { reson8FragmentDefinition } from "../definition";
import { missingAuthorizationError, resolveAuthorizationHeader } from "./shared";

export const reson8AuthTokenSchema = z.object({
  access_token: z.string(),
  token_type: z.literal("Bearer"),
  expires_in: z.number(),
});

export type Reson8AuthToken = z.infer<typeof reson8AuthTokenSchema>;

export const authRoutesFactory = defineRoutes(reson8FragmentDefinition).create(
  ({ defineRoute, deps, config }) => [
    defineRoute({
      method: "POST",
      path: "/auth/token",
      outputSchema: reson8AuthTokenSchema,
      errorCodes: ["UNAUTHORIZED", "INTERNAL_ERROR"] as const,
      handler: async function ({ headers }, { json, error }) {
        const authorization = resolveAuthorizationHeader(headers, config);

        if (!authorization) {
          return error(missingAuthorizationError(), 401);
        }

        const result = await deps.reson8.requestToken({ authorization });

        return result.ok ? json(result.data) : error(result.error, { status: result.status });
      },
    }),
  ],
);
