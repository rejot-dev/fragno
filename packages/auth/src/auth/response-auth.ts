import { z } from "zod";

import type { CookieOptions } from "../utils/cookie";
import { buildIssuedCredentialHeaders } from "./credential-strategy";
import type { IssuedAuthCredential } from "./types";

export const issuedAuthSchema = z.object({
  token: z.string(),
  kind: z.enum(["session", "jwt"]),
  expiresAt: z.string().nullable(),
  activeOrganizationId: z.string().nullable(),
});

export const serializeIssuedAuthCredential = (credential: IssuedAuthCredential) => ({
  token: credential.token,
  kind: credential.kind,
  expiresAt: credential.expiresAt?.toISOString() ?? null,
  activeOrganizationId: credential.activeOrganizationId,
});

export const buildIssuedAuthResponse = (
  credential: IssuedAuthCredential,
  cookieOptions?: CookieOptions,
): {
  auth: ReturnType<typeof serializeIssuedAuthCredential>;
  headers: { "Set-Cookie": string };
} => ({
  auth: serializeIssuedAuthCredential(credential),
  headers: buildIssuedCredentialHeaders(credential, cookieOptions),
});
