import { z } from "zod";

import {
  authConfigSchema,
  type ApiFragmentConfig,
  type ApiRequestInput,
  type AuthConfig,
} from "./api-types";
import {
  createAuthorizationUrl,
  createCodeChallenge,
  exchangeAuthorizationCode,
  randomBase64Url,
  refreshOAuthToken,
  requestClientCredentialsToken,
  tokenExpiry,
  oauthTokensSchema,
} from "./oauth";

export type SecretRecord = {
  id: { toString(): string } | string;
  kind: string;
  payload: string;
  expiresAt?: Date | string | null;
};

export const storedAuthPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bearer"), token: z.string().min(1) }),
  authConfigSchema.options[2].extend({ tokens: oauthTokensSchema.optional() }),
  authConfigSchema.options[3].extend({
    tokens: oauthTokensSchema.optional(),
    redirectUri: z.string().url().optional(),
  }),
]);

type StoredAuthPayload = z.infer<typeof storedAuthPayloadSchema>;

const TOKEN_EXPIRY_SKEW_MS = 30_000;

export interface AuthPersistenceChanges {
  authPayload?: string;
  authExpiresAt?: Date | null;
}

export function assertAllowedBaseUrl(baseUrl: string, config: ApiFragmentConfig) {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("API base URL must be an HTTP(S) URL");
  }
  if (config.allowedBaseUrls && !config.allowedBaseUrls(url)) {
    throw new Error("API base URL is not allowed");
  }
  return url;
}

export function defaultOAuthRedirectUri(config: ApiFragmentConfig) {
  return `${config.publicBaseUrl.replace(/\/$/, "")}/oauth/callback`;
}

function secretByKind<TSecret extends { kind: string }>(secrets: TSecret[], kind: string) {
  return secrets.find((secret) => secret.kind === kind);
}

function secretExpiresInFuture(secret: Pick<SecretRecord, "expiresAt"> | undefined) {
  if (!secret?.expiresAt) {
    return false;
  }
  return new Date(secret.expiresAt).getTime() > Date.now() + TOKEN_EXPIRY_SKEW_MS;
}

function secretIsUnexpired(secret: Pick<SecretRecord, "expiresAt"> | undefined) {
  return !secret?.expiresAt || secretExpiresInFuture(secret);
}

export async function createOAuthStartSnapshot(args: {
  config: ApiFragmentConfig;
  connection: { id: { toString(): string } | string };
  auth: Extract<AuthConfig, { type: "oauth" }>;
  stateId: string;
  redirectUri: string;
  scopes?: string[];
  extraAuthorizationParams?: Record<string, string>;
}) {
  const codeVerifier = randomBase64Url(32);
  const codeChallenge = await createCodeChallenge(codeVerifier);
  const scopes = args.scopes ?? args.auth.scopes;
  const authorizationUrl = createAuthorizationUrl({
    authorizationEndpoint: args.auth.authorizationEndpoint,
    clientId: args.auth.clientId,
    redirectUri: args.redirectUri,
    state: args.stateId,
    scopes,
    codeChallenge,
    extraParams: {
      ...args.auth.extraAuthorizationParams,
      ...args.extraAuthorizationParams,
    },
  });
  return {
    authorizationUrl,
    oauthState: {
      id: args.stateId,
      connectionId: args.connection.id.toString(),
      codeVerifier,
      redirectUri: args.redirectUri,
      scope: scopes?.join(" ") ?? null,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  };
}

export async function createOAuthCallbackSnapshot(args: {
  config: ApiFragmentConfig;
  stateId: string;
  code: string;
  state: {
    codeVerifier: string;
    redirectUri: string;
    scope?: string | null;
    expiresAt: Date | string;
    consumedAt?: Date | string | null;
  };
  auth: Extract<AuthConfig, { type: "oauth" }>;
}) {
  const tokens = await exchangeAuthorizationCode({
    auth: args.auth,
    code: args.code,
    redirectUri: args.state.redirectUri,
    codeVerifier: args.state.codeVerifier,
    fetchImplementation: args.config.fetch,
  });
  return {
    authPayload: JSON.stringify({
      ...args.auth,
      redirectUri: args.state.redirectUri,
      tokens,
    }),
    authExpiresAt: tokenExpiry(tokens),
  } satisfies AuthPersistenceChanges;
}

async function resolveOAuthAuth(args: {
  config: ApiFragmentConfig;
  authSecret: SecretRecord;
  authPayload: Extract<StoredAuthPayload, { type: "oauth" }>;
}) {
  if (!args.authPayload.tokens?.accessToken) {
    return {};
  }
  if (secretIsUnexpired(args.authSecret)) {
    return { token: args.authPayload.tokens.accessToken };
  }
  if (!args.authPayload.tokens.refreshToken) {
    throw new Error("OAuth access token expired and no refresh token is available");
  }
  const tokens = await refreshOAuthToken({
    auth: args.authPayload,
    refreshToken: args.authPayload.tokens.refreshToken,
    fetchImplementation: args.config.fetch,
  });
  if (!tokens.accessToken) {
    throw new Error("OAuth refresh did not return an access token");
  }
  return {
    token: tokens.accessToken,
    authChanges: {
      authPayload: JSON.stringify({ ...args.authPayload, tokens }),
      authExpiresAt: tokenExpiry(tokens),
    },
  };
}

async function resolveClientCredentialsAuth(args: {
  config: ApiFragmentConfig;
  authSecret: SecretRecord;
  authPayload: Extract<StoredAuthPayload, { type: "client_credentials" }>;
}) {
  if (args.authPayload.tokens?.accessToken && secretExpiresInFuture(args.authSecret)) {
    return { token: args.authPayload.tokens.accessToken };
  }
  const tokens = await requestClientCredentialsToken({
    auth: args.authPayload,
    fetchImplementation: args.config.fetch,
  });
  if (!tokens.accessToken) {
    throw new Error("Client credentials flow did not return an access token");
  }
  return {
    token: tokens.accessToken,
    authChanges: {
      authPayload: JSON.stringify({ ...args.authPayload, tokens }),
      authExpiresAt: tokenExpiry(tokens),
    },
  };
}

export async function resolveApiOperationAuth(args: {
  config: ApiFragmentConfig;
  secrets: SecretRecord[];
}): Promise<{ token?: string; authChanges?: AuthPersistenceChanges }> {
  const authSecret = secretByKind(args.secrets, "auth");
  const authPayload = authSecret
    ? storedAuthPayloadSchema.parse(JSON.parse(authSecret.payload))
    : undefined;
  if (!authPayload) {
    return {};
  }
  if (authPayload.type === "bearer") {
    return { token: authPayload.token };
  }
  if (authPayload.type === "oauth") {
    return resolveOAuthAuth({ config: args.config, authSecret: authSecret!, authPayload });
  }
  return resolveClientCredentialsAuth({
    config: args.config,
    authSecret: authSecret!,
    authPayload,
  });
}

function resolveRequestUrl(baseUrl: string, path: string, query?: Record<string, string>) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) {
    throw new Error("API request path must be relative");
  }
  const url = new URL(
    path.startsWith("/") ? path.slice(1) : path,
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  );
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url;
}

export async function performApiRequest(args: {
  config: ApiFragmentConfig;
  baseUrl: string;
  token?: string;
  request: ApiRequestInput;
}) {
  const url = resolveRequestUrl(args.baseUrl, args.request.path, args.request.query);
  const headers = new Headers(args.request.headers ?? {});
  headers.delete("authorization");
  headers.delete("Authorization");
  if (args.token) {
    headers.set("authorization", `Bearer ${args.token}`);
  }
  let body: BodyInit | undefined;
  if (args.request.json !== undefined) {
    headers.set("content-type", headers.get("content-type") ?? "application/json");
    body = JSON.stringify(args.request.json);
  } else if (args.request.body !== undefined) {
    body = args.request.body;
  }

  const controller = args.request.timeoutMs ? new AbortController() : undefined;
  const timeout = controller
    ? setTimeout(() => controller.abort(), args.request.timeoutMs)
    : undefined;
  try {
    const response = await (args.config.fetch ?? fetch)(url, {
      method: args.request.method,
      headers,
      body,
      signal: controller?.signal,
    });
    const responseHeaders = Object.fromEntries(response.headers.entries());
    const contentType = response.headers.get("content-type") ?? "";
    const responseBody = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    return { status: response.status, headers: responseHeaders, body: responseBody };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
