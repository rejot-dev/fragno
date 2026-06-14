import type { CookieOptions } from "../utils/cookie";
import {
  hasMultipleRequestCredentials,
  parseBearerToken,
  resolveRequestCredentialCandidates,
} from "./request-auth";
import {
  verifySessionAccessTokenDetailed,
  type ResolvedSessionAccessTokenConfig,
} from "./session-access-token";
import type { AuthPrincipal } from "./types";

export interface VerifyAuthAccessTokenFromRequestInput {
  headers: Headers;
  accessTokens: ResolvedSessionAccessTokenConfig;
  cookieOptions?: CookieOptions;
}

export type VerifyAuthAccessTokenFromRequestResult<TContext = unknown> =
  | {
      ok: true;
      principal: AuthPrincipal & { auth: AuthPrincipal["auth"] & { sessionContext: TContext } };
    }
  | { ok: false; reason: "missing" | "malformed" | "multiple" | "expired" | "invalid" };

export async function verifyAuthAccessTokenFromRequest<TContext = unknown>(
  input: VerifyAuthAccessTokenFromRequestInput,
): Promise<VerifyAuthAccessTokenFromRequestResult<TContext>> {
  if (hasMultipleRequestCredentials(input.headers, input.cookieOptions)) {
    return { ok: false, reason: "multiple" };
  }

  const credentials = resolveRequestCredentialCandidates(input.headers, input.cookieOptions);
  if (credentials.length === 0) {
    const bearerToken = parseBearerToken(input.headers.get("Authorization"));
    return !bearerToken.ok && bearerToken.reason === "malformed"
      ? { ok: false, reason: "malformed" }
      : { ok: false, reason: "missing" };
  }

  let firstFailure: Extract<VerifyAuthAccessTokenFromRequestResult, { ok: false }> | null = null;
  for (const credential of credentials) {
    if (credential.source === "authorization-header" && !input.accessTokens.acceptBearer) {
      firstFailure ??= { ok: false, reason: "invalid" };
      continue;
    }
    if (credential.source === "cookie" && !input.accessTokens.issueCookie) {
      firstFailure ??= { ok: false, reason: "invalid" };
      continue;
    }

    const result = await verifySessionAccessTokenDetailed({
      config: input.accessTokens,
      token: credential.token,
      source: credential.source,
    });
    if (result.ok) {
      return {
        ok: true,
        principal: result.principal as VerifyAuthAccessTokenFromRequestResult<TContext> extends {
          ok: true;
          principal: infer P;
        }
          ? P
          : never,
      };
    }

    firstFailure ??= result;
  }

  return firstFailure ?? { ok: false, reason: "invalid" };
}
