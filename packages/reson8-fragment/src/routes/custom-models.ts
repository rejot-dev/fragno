import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import { reson8FragmentDefinition } from "../definition";
import { missingAuthorizationError, resolveAuthorizationHeader } from "./shared";

export const reson8CustomModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  phraseCount: z.number(),
});

export const reson8ListCustomModelsOutputSchema = z.array(reson8CustomModelSchema);

export const reson8CreateCustomModelInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  phrases: z.array(z.string().min(1)).nonempty(),
});

export type Reson8CustomModel = z.infer<typeof reson8CustomModelSchema>;
export type Reson8ListCustomModelsOutput = z.infer<typeof reson8ListCustomModelsOutputSchema>;
export type Reson8CreateCustomModelInput = z.infer<typeof reson8CreateCustomModelInputSchema>;

export const customModelRoutesFactory = defineRoutes(reson8FragmentDefinition).create(
  ({ defineRoute, deps, config }) => [
    defineRoute({
      method: "GET",
      path: "/custom-model",
      outputSchema: reson8ListCustomModelsOutputSchema,
      errorCodes: ["UNAUTHORIZED", "INTERNAL_ERROR"] as const,
      handler: async function ({ headers }, { json, error }) {
        const authorization = resolveAuthorizationHeader(headers, config);

        if (!authorization) {
          return error(missingAuthorizationError(), 401);
        }

        const result = await deps.reson8.listCustomModels({ authorization });

        return result.ok ? json(result.data) : error(result.error, { status: result.status });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/custom-model/:id",
      outputSchema: reson8CustomModelSchema,
      errorCodes: ["UNAUTHORIZED", "NOT_FOUND", "INTERNAL_ERROR"] as const,
      handler: async function ({ headers, pathParams }, { json, error }) {
        const authorization = resolveAuthorizationHeader(headers, config);

        if (!authorization) {
          return error(missingAuthorizationError(), 401);
        }

        const result = await deps.reson8.getCustomModel({
          authorization,
          id: pathParams.id,
        });

        return result.ok ? json(result.data) : error(result.error, { status: result.status });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/custom-model",
      inputSchema: reson8CreateCustomModelInputSchema,
      outputSchema: reson8CustomModelSchema,
      errorCodes: ["INVALID_REQUEST", "UNAUTHORIZED", "INTERNAL_ERROR"] as const,
      handler: async function ({ headers, input }, { json, error }) {
        const authorization = resolveAuthorizationHeader(headers, config);

        if (!authorization) {
          return error(missingAuthorizationError(), 401);
        }

        const payload = await input.valid();
        const result = await deps.reson8.createCustomModel({
          authorization,
          body: payload,
        });

        return result.ok ? json(result.data, 201) : error(result.error, { status: result.status });
      },
    }),
  ],
);
