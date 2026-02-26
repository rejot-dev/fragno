export type Awaitable<T> = T | Promise<T>;

export interface OAuth2Tokens {
  tokenType?: string;
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: Date;
  refreshTokenExpiresAt?: Date;
  scopes?: string[];
  idToken?: string;
  raw?: Record<string, unknown>;
}

export interface OAuth2UserInfo {
  id: string | number;
  name?: string;
  email?: string | null;
  image?: string;
  emailVerified: boolean;
  [key: string]: unknown;
}

export interface OAuthProvider<
  TProfile extends object = Record<string, unknown>,
  TOptions extends object = Partial<ProviderOptions<TProfile>>,
> {
  id: string;
  name: string;
  createAuthorizationURL: (data: {
    state: string;
    scopes?: string[];
    redirectURI: string;
    display?: string;
    loginHint?: string;
    codeVerifier?: string;
  }) => Awaitable<URL>;
  validateAuthorizationCode: (data: {
    code: string;
    redirectURI: string;
    codeVerifier?: string;
    deviceId?: string;
  }) => Promise<OAuth2Tokens | null>;
  getUserInfo: (
    token: OAuth2Tokens & {
      user?: {
        name?: {
          firstName?: string;
          lastName?: string;
        };
        email?: string;
      };
    },
  ) => Promise<{
    user: OAuth2UserInfo;
    data: TProfile;
  } | null>;
  refreshAccessToken?: (refreshToken: string) => Promise<OAuth2Tokens>;
  revokeToken?: (token: string) => Promise<void>;
  verifyIdToken?: (token: string, nonce?: string) => Promise<boolean>;
  disableImplicitSignUp?: boolean;
  disableSignUp?: boolean;
  options?: TOptions;
}

export type ProviderOptions<Profile extends object = Record<string, unknown>> = {
  clientId?: string;
  clientSecret?: string;
  scope?: string[];
  disableDefaultScope?: boolean;
  redirectURI?: string;
  authorizationEndpoint?: string;
  clientKey?: string;
  disableIdTokenSignIn?: boolean;
  verifyIdToken?: (token: string, nonce?: string) => Promise<boolean>;
  getUserInfo?: (token: OAuth2Tokens) => Promise<{
    user: {
      id: string | number;
      name?: string;
      email?: string | null;
      image?: string;
      emailVerified: boolean;
      [key: string]: unknown;
    };
    data: Profile;
  } | null>;
  refreshAccessToken?: (refreshToken: string) => Promise<OAuth2Tokens>;
  mapProfileToUser?: (profile: Profile) =>
    | {
        id?: string;
        name?: string;
        email?: string | null;
        image?: string;
        emailVerified?: boolean;
        [key: string]: unknown;
      }
    | Promise<{
        id?: string;
        name?: string;
        email?: string | null;
        image?: string;
        emailVerified?: boolean;
        [key: string]: unknown;
      }>;
  disableImplicitSignUp?: boolean;
  disableSignUp?: boolean;
  prompt?: string;
};

export interface AuthOAuthConfig {
  providers: Record<string, OAuthProvider>;
  defaultRedirectUri?: string;
  stateTtlMs?: number;
  linkByEmail?: boolean;
  tokenStorage?: "none" | "refresh" | "all";
}
