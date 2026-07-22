import { z } from "zod";

import { parseSecretPayload } from "./mcp-api";
import type { AuthPersistenceChanges } from "./services";

const serverConnectionCacheOutputSchema = z.object({
  protocolVersion: z.string().nullable().optional(),
  serverInfo: z.unknown().nullable().optional(),
  capabilities: z.unknown().nullable().optional(),
  tools: z.array(z.unknown()).nullable().optional(),
  updatedAt: z.union([z.string(), z.date()]).optional(),
});

const serverOutputSchema = z.object({
  slug: z.string(),
  name: z.string().nullable().optional(),
  endpointUrl: z.string(),
  authMode: z.string(),
  cache: serverConnectionCacheOutputSchema.nullable().optional(),
});

export const refreshOutputSchema = z.object({
  ok: z.boolean(),
  tools: z.array(z.unknown()),
  stage: z.enum(["auth", "list_tools"]).nullable(),
  checkedAt: z.string(),
  server: serverOutputSchema.omit({ cache: true }),
  auth: z.object({
    authenticated: z.boolean(),
    mode: z.string(),
    tokenPresent: z.boolean(),
    expiresAt: z.union([z.string(), z.date()]).nullable(),
    expired: z.boolean().nullable(),
    scopes: z.object({
      requested: z.array(z.string()).nullable(),
      granted: z.array(z.string()).nullable(),
      missing: z.array(z.string()).nullable(),
      raw: z.string().nullable(),
    }),
  }),
  live: z.object({
    reachable: z.boolean(),
    listToolsOk: z.boolean(),
    toolCount: z.number().nullable(),
    protocolVersion: z.string().nullable(),
    serverInfo: z.unknown().nullable(),
    capabilities: z.unknown().nullable(),
  }),
  cache: z.object({
    presentBeforeCheck: z.boolean(),
    previousToolCount: z.number().nullable(),
    updatedToolCount: z.number().nullable(),
  }),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});

export type SecretForDiagnostics = {
  id: { toString(): string } | string;
  kind: string;
  payload: string;
  expiresAt?: Date | string | null;
};

export type OAuthStateForDiagnostics = {
  scope?: string | null;
  expiresAt: Date | string;
};

type AuthPayloadForDiagnostics =
  | { type: "bearer"; token?: string }
  | { type: "oauth"; tokens?: { access_token?: string; scope?: string } }
  | {
      type: "client_credentials";
      scopes?: string[];
      tokens?: { access_token?: string; scope?: string };
    };

const splitScope = (scope: string | null | undefined) => {
  const scopes = scope?.split(/\s+/).filter(Boolean) ?? [];
  return scopes.length > 0 ? scopes : null;
};

const newestOAuthScope = (states: OAuthStateForDiagnostics[]) => {
  const [state] = states.toSorted(
    (left, right) => new Date(right.expiresAt).getTime() - new Date(left.expiresAt).getTime(),
  );
  return splitScope(state?.scope);
};

export const buildAuthDiagnostics = ({
  mode,
  secrets,
  oauthStates,
  authChanges,
}: {
  mode: string;
  secrets: SecretForDiagnostics[];
  oauthStates: OAuthStateForDiagnostics[];
  authChanges?: AuthPersistenceChanges;
}) => {
  const authSecret = secrets.find((secret) => secret.kind === "auth");
  const authPayload = authChanges?.authPayload ?? authSecret?.payload;
  const authExpiresAt = authChanges?.authExpiresAt ?? authSecret?.expiresAt ?? null;
  const parsedAuth = authPayload
    ? parseSecretPayload<AuthPayloadForDiagnostics>(authPayload)
    : undefined;
  const granted = splitScope(
    parsedAuth?.type === "oauth" || parsedAuth?.type === "client_credentials"
      ? parsedAuth.tokens?.scope
      : undefined,
  );
  const requested =
    parsedAuth?.type === "client_credentials"
      ? (parsedAuth.scopes ?? null)
      : mode === "oauth"
        ? newestOAuthScope(oauthStates)
        : null;
  const grantedScopes = granted ? new Set(granted) : null;
  const missing =
    requested && grantedScopes ? requested.filter((scope) => !grantedScopes.has(scope)) : null;
  const tokenPresent =
    parsedAuth?.type === "bearer"
      ? Boolean(parsedAuth.token)
      : Boolean(parsedAuth?.tokens?.access_token);
  const expired = authExpiresAt ? new Date(authExpiresAt).getTime() <= Date.now() : null;

  return {
    authenticated: mode === "none" || tokenPresent,
    mode,
    tokenPresent,
    expiresAt: authExpiresAt,
    expired,
    scopes: {
      requested,
      granted,
      missing,
      raw:
        parsedAuth?.type === "oauth" || parsedAuth?.type === "client_credentials"
          ? (parsedAuth.tokens?.scope ?? null)
          : null,
    },
  };
};

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
