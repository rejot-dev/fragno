import type { OAuth2Tokens } from "../../types";
import type { GithubEmail, GithubProfile } from "./github";

export interface GithubOAuthClient {
  exchangeCode: (params: {
    code: string;
    redirectURI: string;
    clientId: string;
    clientSecret: string;
    codeVerifier?: string;
  }) => Promise<OAuth2Tokens | null>;
  fetchProfile: (accessToken: string) => Promise<GithubProfile | null>;
  fetchEmails: (accessToken: string) => Promise<GithubEmail[]>;
}
