import { createRemoteJWKSet, customFetch, errors, jwtVerify } from "jose";
import { z } from "zod";

import { appInstallationExternalAccountSchema } from "./apps";
import { jsonValueSchema } from "./shared/json";

/** Issuer of every token Backoffice's auth server signs. */
export const BACKOFFICE_TOKEN_ISSUER = "fragno-backoffice-auth";

/** Short enough that a captured request cannot be replayed later. */
export const APP_ACTION_TOKEN_LIFETIME_SECONDS = 60;

/** The JSON body Backoffice POSTs to an app's action endpoint. */
export const appActionRequestSchema = z.discriminatedUnion("type", [
  // integrations.verify proves the endpoint accepts Backoffice's signature without running an action.
  z.strictObject({ type: z.literal("ping") }),
  z.strictObject({
    type: z.literal("action"),
    actionId: z.string().min(1),
    input: jsonValueSchema.describe("Validated against the action's declared input schema."),
  }),
]);
export type AppActionRequest = z.infer<typeof appActionRequestSchema>;

/**
 * The bearer token on every action request. Its audience is the app's endpoint URL, so a request
 * sent to one app cannot be replayed against another.
 */
export const appActionTokenClaimsSchema = z.object({
  iss: z.literal(BACKOFFICE_TOKEN_ISSUER),
  aud: z.string().min(1),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  /** Unique per request; apps may use it as an idempotency key. */
  jti: z.string().min(1),
  sub: z.string().min(1),
  /** The Backoffice user behind the call, or the installation itself for automated calls. */
  actor: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("user"), userId: z.string().min(1) }),
    z.strictObject({ kind: z.literal("installation") }),
  ]),
  installation: z.strictObject({
    appId: z.string().min(1),
    activation: z.number().int().positive(),
    externalAccount: appInstallationExternalAccountSchema,
  }),
  scopeRestriction: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("org"), orgId: z.string().min(1) }),
    z.strictObject({
      kind: z.literal("project"),
      orgId: z.string().min(1),
      projectId: z.string().min(1),
    }),
  ]),
  /** Base64url SHA-256 of the exact request body bytes. */
  bodySha256: z.string().min(1),
});
export type AppActionTokenClaims = z.infer<typeof appActionTokenClaimsSchema>;

/** Binds a token to one body; Backoffice signs it and the app's verifier recomputes it. */
export async function appActionBodySha256(body: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
  );
  let binary = "";
  for (const byte of digest) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A request the endpoint must refuse; `status` is the HTTP status to answer with. */
export class AppActionRequestError extends Error {
  readonly status: 400 | 401 | 405;

  constructor(status: 400 | 401 | 405, message: string) {
    super(message);
    this.name = "AppActionRequestError";
    this.status = status;
  }
}

export type VerifiedAppActionRequest = {
  claims: AppActionTokenClaims;
  request: AppActionRequest;
};

/**
 * Creates the verifier for an app's action endpoint. It checks Backoffice's signature, that the
 * token is addressed to `endpointUrl` and unexpired, and that it signs this exact body. Signing keys
 * come from `<backofficeOrigin>/api/auth/jwks` through `fetch` and are cached between requests.
 */
export function createAppActionVerifier({
  backofficeOrigin,
  endpointUrl,
  fetch,
}: {
  backofficeOrigin: string;
  endpointUrl: string;
  fetch: typeof globalThis.fetch;
}): (request: Request) => Promise<VerifiedAppActionRequest> {
  const jwks = createRemoteJWKSet(new URL("/api/auth/jwks", backofficeOrigin), {
    [customFetch]: fetch,
  });
  return async function verifyAppActionRequest(request) {
    if (request.method !== "POST") {
      throw new AppActionRequestError(405, "App action requests use POST.");
    }
    const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!token) {
      throw new AppActionRequestError(401, "App action request is missing its bearer token.");
    }
    const body = await request.text();
    let claims: AppActionTokenClaims;
    try {
      const verified = await jwtVerify(token, jwks, {
        issuer: BACKOFFICE_TOKEN_ISSUER,
        audience: endpointUrl,
      });
      claims = appActionTokenClaimsSchema.parse(verified.payload);
    } catch (error) {
      throw new AppActionRequestError(
        401,
        error instanceof errors.JWTExpired
          ? "App action token expired."
          : "App action token is invalid.",
      );
    }
    if (claims.exp - claims.iat > APP_ACTION_TOKEN_LIFETIME_SECONDS) {
      throw new AppActionRequestError(401, "App action token lives longer than allowed.");
    }
    if ((await appActionBodySha256(body)) !== claims.bodySha256) {
      throw new AppActionRequestError(401, "App action token does not sign this request body.");
    }
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new AppActionRequestError(400, "App action request body is not JSON.");
    }
    const parsed = appActionRequestSchema.safeParse(json);
    if (!parsed.success) {
      throw new AppActionRequestError(400, "App action request body is malformed.");
    }
    return { claims, request: parsed.data };
  };
}
