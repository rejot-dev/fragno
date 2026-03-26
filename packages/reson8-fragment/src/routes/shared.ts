import { z } from "zod";

import type { Reson8FragmentConfig } from "../definition";

export const reson8ErrorSchema = z.object({
  message: z.string(),
  code: z.string(),
});

export type Reson8Error = z.infer<typeof reson8ErrorSchema>;

export const resolveAuthorizationHeader = (
  headers: Headers,
  config: Reson8FragmentConfig,
): string | null => {
  return (
    headers.get("authorization") ??
    config.defaultAuthorization ??
    (config.apiKey ? `ApiKey ${config.apiKey}` : null)
  );
};

export const missingAuthorizationError = () => ({
  code: "UNAUTHORIZED" as const,
  message:
    "Missing Reson8 credentials. Provide an Authorization header or configure apiKey/defaultAuthorization.",
});
