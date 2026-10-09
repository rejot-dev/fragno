import { backofficeContextScopeSchema } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

/** OAuth execution token requests choose a scope, never a client policy or principal. */
export const backofficeExecutionTokenRequestSchema = z.strictObject({
  scope: backofficeContextScopeSchema.nullable(),
});

/** Validates the Auth RPC boundary; OAuth identity comes from the bearer token. */
export const backofficeExecutionTokenExchangeInputSchema =
  backofficeExecutionTokenRequestSchema.extend({
    requestUrl: z.url(),
    oauthAccessToken: z.string().min(1),
  });
export type BackofficeExecutionTokenExchangeInput = z.infer<
  typeof backofficeExecutionTokenExchangeInputSchema
>;

/** Execution credentials carry a concrete scope ceiling and remain distinct from OAuth tokens. */
export const backofficeExecutionTokenResultSchema = z.strictObject({
  accessToken: z.string().min(1),
  expiresAt: z.iso.datetime(),
  scope: backofficeContextScopeSchema,
});
export type BackofficeExecutionTokenResult = z.infer<typeof backofficeExecutionTokenResultSchema>;

/** Reports an OAuth credential or client policy that cannot authorize execution token issuance. */
export class BackofficeExecutionTokenAuthenticationError extends Error {
  override readonly name = "BackofficeExecutionTokenAuthenticationError";
}

/** Reports an authenticated caller that cannot receive authority for the requested scope. */
export class BackofficeExecutionTokenScopeError extends Error {
  override readonly name = "BackofficeExecutionTokenScopeError";
}
