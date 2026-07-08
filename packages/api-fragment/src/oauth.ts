import { z } from "zod";

import type { AuthConfig } from "./api-types";
import { asciiToBase64, sha256Base64Url } from "./crypto";

export interface OAuthTokens {
  tokenType?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
  idToken?: string;
  raw?: Record<string, unknown>;
}

export const oauthTokensSchema = z.object({
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  tokenType: z.string().optional(),
  expiresIn: z.number().finite().optional(),
  scope: z.string().optional(),
  idToken: z.string().optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});

const oauthTokenResponseSchema = z.looseObject({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  token_type: z.string().optional(),
  expires_in: z.coerce.number().finite().optional(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
});

export { bytesToBase64Url, randomBase64Url } from "./crypto";

export async function createCodeChallenge(codeVerifier: string) {
  return await sha256Base64Url(codeVerifier);
}

export function createAuthorizationUrl(args: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: string[];
  codeChallenge: string;
  extraParams?: Record<string, string>;
}) {
  const url = new URL(args.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("state", args.state);
  url.searchParams.set("code_challenge", args.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (args.scopes?.length) {
    url.searchParams.set("scope", args.scopes.join(" "));
  }
  for (const [key, value] of Object.entries(args.extraParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return url;
}

async function parseTokenResponse(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : Object.fromEntries(new URLSearchParams(await response.text()));
  if (!response.ok) {
    const message =
      typeof data?.error_description === "string"
        ? data.error_description
        : typeof data?.error === "string"
          ? data.error
          : `Token request failed with status ${response.status}`;
    throw new Error(message);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Token response was empty");
  }
  const parsed = oauthTokenResponseSchema.parse(data);
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    tokenType: parsed.token_type,
    scope: parsed.scope,
    idToken: parsed.id_token,
    expiresIn: parsed.expires_in,
    raw: data as Record<string, unknown>,
  } satisfies OAuthTokens;
}

function applyClientAuthentication(
  body: URLSearchParams,
  headers: Headers,
  auth: Extract<AuthConfig, { type: "oauth" | "client_credentials" }>,
) {
  const method = auth.tokenEndpointAuthMethod ?? "client_secret_basic";
  if (method === "client_secret_basic" && auth.clientSecret) {
    headers.set(
      "authorization",
      `Basic ${asciiToBase64(`${auth.clientId}:${auth.clientSecret}`, "OAuth client credentials")}`,
    );
    return;
  }
  body.set("client_id", auth.clientId);
  if (auth.clientSecret && method === "client_secret_post") {
    body.set("client_secret", auth.clientSecret);
  }
}

export async function exchangeAuthorizationCode(args: {
  auth: Extract<AuthConfig, { type: "oauth" }>;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  fetchImplementation?: typeof fetch;
}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    code_verifier: args.codeVerifier,
  });
  for (const [key, value] of Object.entries(args.auth.extraTokenParams ?? {})) {
    body.set(key, value);
  }
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  });
  applyClientAuthentication(body, headers, args.auth);
  const response = await (args.fetchImplementation ?? fetch)(args.auth.tokenEndpoint, {
    method: "POST",
    headers,
    body,
  });
  return parseTokenResponse(response);
}

export async function requestClientCredentialsToken(args: {
  auth: Extract<AuthConfig, { type: "client_credentials" }>;
  fetchImplementation?: typeof fetch;
}) {
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  if (args.auth.scopes?.length) {
    body.set("scope", args.auth.scopes.join(" "));
  }
  if (args.auth.audience) {
    body.set("audience", args.auth.audience);
  }
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  });
  applyClientAuthentication(body, headers, args.auth);
  const response = await (args.fetchImplementation ?? fetch)(args.auth.tokenEndpoint, {
    method: "POST",
    headers,
    body,
  });
  return parseTokenResponse(response);
}

export async function refreshOAuthToken(args: {
  auth: Extract<AuthConfig, { type: "oauth" }>;
  refreshToken: string;
  fetchImplementation?: typeof fetch;
}) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
  });
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  });
  applyClientAuthentication(body, headers, args.auth);
  const response = await (args.fetchImplementation ?? fetch)(args.auth.tokenEndpoint, {
    method: "POST",
    headers,
    body,
  });
  return parseTokenResponse(response);
}

export function tokenExpiry(tokens: OAuthTokens) {
  return typeof tokens.expiresIn === "number"
    ? new Date(Date.now() + tokens.expiresIn * 1000)
    : null;
}
