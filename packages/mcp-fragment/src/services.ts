import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

import { parseSecretPayload, stringifySecretPayload } from "./mcp-api";
import type { McpFragmentConfig } from "./mcp-types";
import {
  BufferedOAuthClientProvider,
  type OAuthProviderChanges,
  type OAuthProviderSnapshot,
} from "./oauth-provider";

export async function prepareOAuthChanges(changes: OAuthProviderChanges) {
  return {
    ...changes,
    clientInformationPayload: changes.clientInformation
      ? stringifySecretPayload(changes.clientInformation)
      : undefined,
    discoveryStatePayload: changes.discoveryState
      ? stringifySecretPayload(changes.discoveryState)
      : undefined,
    tokensPayload: changes.tokens
      ? stringifySecretPayload({ type: "oauth", tokens: changes.tokens })
      : undefined,
  };
}

export function tokenExpiry(tokens: NonNullable<OAuthProviderChanges["tokens"]>): Date | null {
  return typeof tokens.expires_in === "number"
    ? new Date(Date.now() + tokens.expires_in * 1000)
    : null;
}

export type AuthPersistenceChanges = Awaited<ReturnType<typeof prepareOAuthChanges>> & {
  authPayload?: string;
  authExpiresAt?: Date | null;
};

export type SecretRecord = {
  id: { toString(): string } | string;
  kind: string;
  payload: string;
  expiresAt?: Date | string | null;
};

type StoredAuthPayload =
  | { type: "bearer"; token: string }
  | { type: "oauth"; tokens?: OAuthTokens; redirectUri?: string }
  | {
      type: "client_credentials";
      clientId: string;
      clientSecret: string;
      scopes?: string[];
      tokens?: NonNullable<OAuthProviderChanges["tokens"]>;
    };

function secretByKind<TSecret extends { kind: string }>(secrets: TSecret[], kind: string) {
  return secrets.find((secret) => secret.kind === kind);
}

function secretExpiresInFuture(secret: Pick<SecretRecord, "expiresAt"> | undefined) {
  if (!secret?.expiresAt) {
    return false;
  }
  return new Date(secret.expiresAt).getTime() > Date.now() + 30_000;
}

function secretIsUnexpired(secret: Pick<SecretRecord, "expiresAt"> | undefined) {
  return !secret?.expiresAt || secretExpiresInFuture(secret);
}

async function parseSecretKind<T>(
  secrets: Pick<SecretRecord, "kind" | "payload">[],
  kind: string,
): Promise<T | undefined> {
  const secret = secretByKind(secrets, kind);
  return secret ? parseSecretPayload<T>(secret.payload) : undefined;
}

export function defaultOAuthRedirectUri(config: McpFragmentConfig) {
  return `${config.publicBaseUrl.replace(/\/$/, "")}/oauth/callback`;
}

export async function createOAuthStartSnapshot(args: {
  config: McpFragmentConfig;
  server: { id: { toString(): string } | string; endpointUrl: string };
  secrets: Pick<SecretRecord, "kind" | "payload">[];
  stateId: string;
  redirectUri: string;
  scope?: string;
  clientId?: string;
  clientSecret?: string;
}): Promise<{
  authorizationUrl: URL;
  changes: Awaited<ReturnType<typeof prepareOAuthChanges>>;
}> {
  const snapshot: OAuthProviderSnapshot = {
    serverId: args.server.id.toString(),
    endpointUrl: args.server.endpointUrl,
    redirectUrl: args.redirectUri,
    scope: args.scope,
    stateId: args.stateId,
    clientId: args.clientId,
    clientSecret: args.clientSecret,
    clientInformation: await parseSecretKind(args.secrets, "oauth-client"),
    discoveryState: await parseSecretKind(args.secrets, "oauth-discovery"),
  };
  const provider = new BufferedOAuthClientProvider(snapshot);
  await auth(provider, {
    serverUrl: snapshot.endpointUrl,
    scope: args.scope,
    fetchFn: args.config.fetch,
  });
  const authorizationUrl = provider.changes.authorizationUrl;
  if (!authorizationUrl) {
    throw new Error("OAuth authorization did not produce a redirect URL");
  }
  return { authorizationUrl, changes: await prepareOAuthChanges(provider.changes) };
}

export async function createOAuthCallbackSnapshot(args: {
  config: McpFragmentConfig;
  stateId: string;
  code: string;
  state: {
    id: { toString(): string } | string;
    codeVerifier: string;
    redirectUri: string;
    scope?: string | null;
    expiresAt: Date | string;
    consumedAt?: Date | string | null;
  };
  server: { id: { toString(): string } | string; endpointUrl: string };
  secrets: Pick<SecretRecord, "kind" | "payload">[];
}): Promise<Awaited<ReturnType<typeof prepareOAuthChanges>>> {
  const authPayload = await parseSecretKind<{ type: string; tokens?: OAuthTokens }>(
    args.secrets,
    "auth",
  );
  const snapshot: OAuthProviderSnapshot = {
    serverId: args.server.id.toString(),
    endpointUrl: args.server.endpointUrl,
    redirectUrl: args.state.redirectUri,
    scope: args.state.scope ?? undefined,
    stateId: args.stateId,
    clientInformation: await parseSecretKind(args.secrets, "oauth-client"),
    tokens: authPayload?.tokens,
    discoveryState: await parseSecretKind(args.secrets, "oauth-discovery"),
    oauthState: {
      id: args.state.id.toString(),
      codeVerifier: args.state.codeVerifier,
      redirectUri: args.state.redirectUri,
      scope: args.state.scope ?? undefined,
      expiresAt: new Date(args.state.expiresAt),
      consumedAt: args.state.consumedAt ? new Date(args.state.consumedAt) : null,
    },
  };
  const provider = new BufferedOAuthClientProvider(snapshot);
  await auth(provider, {
    serverUrl: snapshot.endpointUrl,
    authorizationCode: args.code,
    scope: snapshot.scope,
    fetchFn: args.config.fetch,
  });
  provider.consumeState();
  return prepareOAuthChanges(provider.changes);
}

export async function resolveMcpOperationAuth(args: {
  config: McpFragmentConfig;
  server: { id: { toString(): string } | string; endpointUrl: string };
  secrets: SecretRecord[];
}): Promise<{
  token?: string;
  authChanges?: AuthPersistenceChanges;
}> {
  const authSecret = secretByKind(args.secrets, "auth");
  const authPayload = authSecret
    ? parseSecretPayload<StoredAuthPayload>(authSecret.payload)
    : undefined;
  if (!authPayload || authPayload.type === "bearer") {
    return { token: authPayload?.token };
  }
  if (authPayload.type === "oauth") {
    if (!authPayload.tokens?.access_token) {
      return {};
    }
    if (secretIsUnexpired(authSecret)) {
      return { token: authPayload.tokens.access_token };
    }
    if (!authPayload.tokens.refresh_token) {
      throw new Error("OAuth access token expired and no refresh token is available");
    }

    const clientSecret = secretByKind(args.secrets, "oauth-client");
    const discoverySecret = secretByKind(args.secrets, "oauth-discovery");
    const provider = new BufferedOAuthClientProvider({
      serverId: args.server.id.toString(),
      endpointUrl: args.server.endpointUrl,
      redirectUrl: authPayload.redirectUri ?? defaultOAuthRedirectUri(args.config),
      scope: authPayload.tokens.scope,
      clientInformation: clientSecret ? parseSecretPayload(clientSecret.payload) : undefined,
      tokens: authPayload.tokens,
      discoveryState: discoverySecret ? parseSecretPayload(discoverySecret.payload) : undefined,
    });
    await auth(provider, {
      serverUrl: args.server.endpointUrl,
      scope: authPayload.tokens.scope,
      fetchFn: args.config.fetch,
    });
    const tokens = provider.changes.tokens ?? authPayload.tokens;
    if (!tokens.access_token) {
      throw new Error("OAuth refresh did not return an access token");
    }
    return {
      token: tokens.access_token,
      authChanges: {
        ...(await prepareOAuthChanges(provider.changes)),
        authPayload: stringifySecretPayload({ ...authPayload, tokens }),
        authExpiresAt: tokenExpiry(tokens),
      },
    };
  }

  if (authPayload.tokens?.access_token && secretExpiresInFuture(authSecret)) {
    return { token: authPayload.tokens.access_token };
  }

  const discoverySecret = secretByKind(args.secrets, "oauth-discovery");
  const provider = new BufferedOAuthClientProvider({
    serverId: args.server.id.toString(),
    endpointUrl: args.server.endpointUrl,
    scope: authPayload.scopes?.join(" "),
    clientId: authPayload.clientId,
    clientSecret: authPayload.clientSecret,
    tokens: authPayload.tokens,
    discoveryState: discoverySecret ? parseSecretPayload(discoverySecret.payload) : undefined,
    flow: "client_credentials",
  });
  await auth(provider, {
    serverUrl: args.server.endpointUrl,
    scope: authPayload.scopes?.join(" "),
    fetchFn: args.config.fetch,
  });
  const tokens = provider.changes.tokens ?? authPayload.tokens;
  if (!tokens?.access_token) {
    throw new Error("Client credentials flow did not return an access token");
  }
  return {
    token: tokens.access_token,
    authChanges: {
      ...(await prepareOAuthChanges(provider.changes)),
      authPayload: stringifySecretPayload({ ...authPayload, tokens }),
      authExpiresAt: tokenExpiry(tokens),
    },
  };
}
