import { randomBytes } from "node:crypto";
import type { AuthOAuthConfig, OAuth2Tokens, OAuthProvider } from "./types";

const base64UrlEncode = (input: Uint8Array): string => {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

export const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;

export const createOAuthState = (bytes = 32): string => {
  return base64UrlEncode(randomBytes(bytes));
};

export const createAuthorizationURL = (params: {
  authorizationEndpoint: string;
  clientId: string;
  redirectURI: string;
  state: string;
  scopes?: string[];
  prompt?: string;
  loginHint?: string;
  codeChallenge?: string;
  codeChallengeMethod?: "S256" | "plain";
  extraParams?: Record<string, string | undefined>;
}): URL => {
  const url = new URL(params.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectURI);
  url.searchParams.set("state", params.state);

  if (params.scopes && params.scopes.length > 0) {
    url.searchParams.set("scope", params.scopes.join(" "));
  }

  if (params.prompt) {
    url.searchParams.set("prompt", params.prompt);
  }

  if (params.loginHint) {
    url.searchParams.set("login_hint", params.loginHint);
  }

  if (params.codeChallenge) {
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", params.codeChallengeMethod ?? "S256");
  }

  if (params.extraParams) {
    for (const [key, value] of Object.entries(params.extraParams)) {
      if (typeof value === "string" && value.length > 0) {
        url.searchParams.set(key, value);
      }
    }
  }

  return url;
};

const parseScopes = (scopeValue: unknown): string[] | undefined => {
  if (typeof scopeValue !== "string") {
    return undefined;
  }
  const scopes = scopeValue
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  return scopes.length > 0 ? scopes : undefined;
};

const readNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

export const normalizeOAuthTokens = (response: Record<string, unknown>): OAuth2Tokens => {
  const accessToken =
    typeof response["access_token"] === "string" ? response["access_token"] : undefined;
  const refreshToken =
    typeof response["refresh_token"] === "string" ? response["refresh_token"] : undefined;
  const tokenType = typeof response["token_type"] === "string" ? response["token_type"] : undefined;
  const idToken = typeof response["id_token"] === "string" ? response["id_token"] : undefined;

  const expiresIn = readNumber(response["expires_in"]);
  const accessTokenExpiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : undefined;

  return {
    accessToken,
    refreshToken,
    tokenType,
    idToken,
    accessTokenExpiresAt,
    scopes: parseScopes(response["scope"]),
    raw: response,
  };
};

export const parseOAuthTokenResponse = async (
  response: Response,
): Promise<
  | {
      ok: true;
      data: Record<string, unknown>;
    }
  | {
      ok: false;
      status: number;
      error: string;
      data?: unknown;
    }
> => {
  const contentType = response.headers.get("content-type") ?? "";
  const status = response.status;

  let data: unknown;
  try {
    if (contentType.includes("application/json")) {
      data = await response.json();
    } else {
      const text = await response.text();
      data = Object.fromEntries(new URLSearchParams(text));
    }
  } catch (err) {
    return {
      ok: false,
      status,
      error: err instanceof Error ? err.message : "Invalid token response",
    };
  }

  if (!response.ok) {
    const message =
      typeof (data as { error_description?: string }).error_description === "string"
        ? (data as { error_description?: string }).error_description!
        : typeof (data as { error?: string }).error === "string"
          ? (data as { error?: string }).error!
          : `Token request failed with status ${status}`;
    return {
      ok: false,
      status,
      error: message,
      data,
    };
  }

  if (!data || typeof data !== "object") {
    return {
      ok: false,
      status,
      error: "Token response was empty",
    };
  }

  return {
    ok: true,
    data: data as Record<string, unknown>,
  };
};

export const normalizeOAuthProvider = (provider: OAuthProvider): OAuthProvider => {
  const providerOptions = provider.options;
  if (!providerOptions) {
    return provider;
  }

  const disableSignUp = provider.disableSignUp ?? providerOptions.disableSignUp;
  const disableImplicitSignUp =
    provider.disableImplicitSignUp ?? providerOptions.disableImplicitSignUp;

  if (
    disableSignUp === provider.disableSignUp &&
    disableImplicitSignUp === provider.disableImplicitSignUp
  ) {
    return provider;
  }

  return {
    ...provider,
    disableSignUp,
    disableImplicitSignUp,
  };
};

export const normalizeOAuthConfig = (config?: AuthOAuthConfig): AuthOAuthConfig | undefined => {
  if (!config) {
    return config;
  }

  const entries = Object.entries(config.providers);
  let changed = false;
  const normalizedProviders: Record<string, OAuthProvider> = {};

  for (const [key, provider] of entries) {
    const normalized = normalizeOAuthProvider(provider);
    normalizedProviders[key] = normalized;
    if (normalized !== provider) {
      changed = true;
    }
  }

  if (!changed) {
    return config;
  }

  return {
    ...config,
    providers: normalizedProviders,
  };
};
