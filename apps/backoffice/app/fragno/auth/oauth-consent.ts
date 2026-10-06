import { z } from "zod";

/** The signed OAuth query remains opaque until Better Auth verifies it. */
export const backofficeOAuthConsentRequestSchema = z.strictObject({
  oauth_query: z.string().min(1).max(32_768),
});

/** Consent review discloses client metadata, not client credentials or app permissions. */
export const backofficeOAuthConsentDetailsSchema = z.object({
  clientId: z.string(),
  clientName: z.string(),
  userEmail: z.string(),
  scopes: z.array(z.string()),
  redirectUri: z.string(),
  resources: z.array(z.string()),
  claimsRequest: z.string().nullable(),
});

/** Consent listing cursors are bound to the signed-in user and page size. */
export const backofficeOAuthConsentListInputSchema = z.strictObject({
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).nullable().default(null),
});

/** User-facing authorizations contain no access tokens, refresh tokens, or client secrets. */
export const backofficeOAuthConsentPageSchema = z.object({
  consents: z.array(
    z.object({
      id: z.string(),
      clientId: z.string(),
      clientName: z.string(),
      scopes: z.array(z.string()),
      resources: z.array(z.string()),
      requestedUserInfoClaims: z.array(z.string()),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
  hasNextPage: z.boolean(),
});

/** Revocation always derives the grant owner from the live browser session. */
export const backofficeOAuthConsentRevokeInputSchema = z.strictObject({
  clientId: z.string().min(1).max(191),
});
