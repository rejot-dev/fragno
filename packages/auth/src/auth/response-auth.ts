import { z } from "zod";

import type { CookieOptions } from "../utils/cookie";
import { buildIssuedCredentialHeaders, type AuthResponseHeaders } from "./credential-strategy";
import type { IssuedAuthCredential } from "./types";

export const issuedAuthSchema = z.object({
  token: z.string(),
  kind: z.enum(["session", "jwt"]),
  expiresAt: z.string().nullable(),
  activeOrganizationId: z.string().nullable(),
  refreshToken: z.string().optional(),
  refreshExpiresAt: z.string().nullable().optional(),
});

export type SerializedIssuedAuthCredential<T extends IssuedAuthCredential = IssuedAuthCredential> =
  {
    token: string;
    kind: T["kind"];
    expiresAt: string | null;
    activeOrganizationId: string | null;
    refreshToken?: string;
    refreshExpiresAt?: string | null;
  };

export const serializeIssuedAuthCredential = <T extends IssuedAuthCredential>(
  credential: T,
): SerializedIssuedAuthCredential<T> => ({
  token: credential.token,
  kind: credential.kind,
  expiresAt: credential.expiresAt?.toISOString() ?? null,
  activeOrganizationId: credential.activeOrganizationId,
  ...(credential.refreshToken ? { refreshToken: credential.refreshToken } : {}),
  ...(credential.refreshExpiresAt !== undefined
    ? { refreshExpiresAt: credential.refreshExpiresAt?.toISOString() ?? null }
    : {}),
});

export const buildIssuedAuthResponse = <T extends IssuedAuthCredential>(
  credential: T,
  cookieOptions?: CookieOptions,
  options?: { issueCookie?: boolean },
): {
  auth: SerializedIssuedAuthCredential<T>;
  headers: AuthResponseHeaders;
} => ({
  auth: serializeIssuedAuthCredential(credential),
  headers: buildIssuedCredentialHeaders(credential, cookieOptions, options),
});
