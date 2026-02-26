import type { OAuthProvider, ProviderOptions, OAuth2Tokens } from "../../types";
import { createAuthorizationURL, normalizeOAuthTokens, parseOAuthTokenResponse } from "../../utils";
import type { GithubOAuthClient } from "./client";

export interface GithubProfile {
  login: string;
  id: string;
  node_id: string;
  avatar_url: string;
  gravatar_id: string;
  url: string;
  html_url: string;
  followers_url: string;
  following_url: string;
  gists_url: string;
  starred_url: string;
  subscriptions_url: string;
  organizations_url: string;
  repos_url: string;
  events_url: string;
  received_events_url: string;
  type: string;
  site_admin: boolean;
  name: string;
  company: string;
  blog: string;
  location: string;
  email: string;
  hireable: boolean;
  bio: string;
  twitter_username: string;
  public_repos: string;
  public_gists: string;
  followers: string;
  following: string;
  created_at: string;
  updated_at: string;
  private_gists: string;
  total_private_repos: string;
  owned_private_repos: string;
  disk_usage: string;
  collaborators: string;
  two_factor_authentication: boolean;
  plan: {
    name: string;
    space: string;
    private_repos: string;
    collaborators: string;
  };
}

export type GithubEmail = {
  email: string;
  primary: boolean;
  verified: boolean;
  visibility: "public" | "private";
};

export interface GithubOptions extends ProviderOptions<GithubProfile> {
  clientId: string;
  clientSecret: string;
  client?: GithubOAuthClient;
}

const defaultScopes = ["read:user", "user:email"];
const defaultUserAgent = "fragno-auth";
const tokenEndpoint = "https://github.com/login/oauth/access_token";
const profileEndpoint = "https://api.github.com/user";
const emailsEndpoint = "https://api.github.com/user/emails";

export const createGithubOAuthClient = (options?: {
  fetcher?: typeof fetch;
  userAgent?: string;
}): GithubOAuthClient => {
  const fetcher = options?.fetcher ?? fetch;
  const userAgent = options?.userAgent ?? defaultUserAgent;

  return {
    exchangeCode: async ({ code, redirectURI, clientId, clientSecret, codeVerifier }) => {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectURI,
      });
      if (codeVerifier) {
        body.set("code_verifier", codeVerifier);
      }

      const response = await fetcher(tokenEndpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      });

      const parsed = await parseOAuthTokenResponse(response);
      if (!parsed.ok) {
        return null;
      }

      return normalizeOAuthTokens(parsed.data);
    },
    fetchProfile: async (accessToken: string) => {
      const response = await fetcher(profileEndpoint, {
        headers: {
          "User-Agent": userAgent,
          authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        return null;
      }

      return (await response.json()) as GithubProfile;
    },
    fetchEmails: async (accessToken: string) => {
      const response = await fetcher(emailsEndpoint, {
        headers: {
          "User-Agent": userAgent,
          authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        return [];
      }

      return (await response.json()) as GithubEmail[];
    },
  };
};

export const github = (options: GithubOptions) => {
  const client = options.client ?? createGithubOAuthClient();
  const authorizationEndpoint =
    options.authorizationEndpoint ?? "https://github.com/login/oauth/authorize";

  return {
    id: "github",
    name: "GitHub",
    options,
    createAuthorizationURL({ state, scopes, loginHint, redirectURI }) {
      const resolvedScopes = options.disableDefaultScope ? [] : [...defaultScopes];
      if (options.scope) {
        resolvedScopes.push(...options.scope);
      }
      if (scopes) {
        resolvedScopes.push(...scopes);
      }

      return createAuthorizationURL({
        authorizationEndpoint,
        clientId: options.clientId,
        redirectURI,
        state,
        scopes: resolvedScopes,
        prompt: options.prompt,
        loginHint: loginHint ?? undefined,
        extraParams: loginHint ? { login: loginHint } : undefined,
      });
    },
    validateAuthorizationCode: async ({ code, redirectURI, codeVerifier }) => {
      return client.exchangeCode({
        code,
        redirectURI: redirectURI,
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        codeVerifier,
      });
    },
    refreshAccessToken: options.refreshAccessToken,
    async getUserInfo(token: OAuth2Tokens) {
      if (options.getUserInfo) {
        return options.getUserInfo(token);
      }

      if (!token.accessToken) {
        return null;
      }

      const profile = await client.fetchProfile(token.accessToken);
      if (!profile) {
        return null;
      }

      const emails = await client.fetchEmails(token.accessToken);

      if (!profile.email && emails.length > 0) {
        profile.email = (emails.find((entry) => entry.primary) ?? emails[0])?.email as string;
      }

      const emailVerified =
        emails.find((entry) => entry.email === profile.email)?.verified ?? false;

      const mapped = await options.mapProfileToUser?.(profile);

      return {
        user: {
          id: profile.id,
          name: profile.name || profile.login,
          email: profile.email ?? null,
          image: profile.avatar_url,
          emailVerified,
          ...mapped,
        },
        data: profile,
      };
    },
  } satisfies OAuthProvider<GithubProfile>;
};
