import type { DatabaseServiceContext } from "@fragno-dev/db";
import { authSchema } from "../schema";
import type { AuthHooksMap, BeforeCreateUserHook } from "../hooks";
import type { AuthOAuthConfig, OAuth2Tokens, OAuth2UserInfo, OAuthProvider } from "./types";
import { createOAuthState, DEFAULT_STATE_TTL_MS, normalizeOAuthConfig } from "./utils";
import { mapUserSummary } from "../user/summary";
import {
  createAutoOrganization,
  type AutoCreateOrganizationOptions,
} from "../user/auto-organization";

export type OAuthStateResult =
  | {
      ok: true;
      state: string;
      redirectUri: string;
      returnTo: string | null;
      expiresAt: Date;
    }
  | {
      ok: false;
      code: "session_invalid";
    };

export type OAuthCallbackResult =
  | {
      ok: true;
      sessionId: string;
      userId: string;
      email: string;
      role: "user" | "admin";
      returnTo: string | null;
    }
  | {
      ok: false;
      code:
        | "invalid_state"
        | "email_required"
        | "signup_disabled"
        | "signup_required"
        | "user_banned";
    };

type AuthServiceContext = DatabaseServiceContext<AuthHooksMap>;

const coerceProviderAccountId = (value: string | number): string => {
  return typeof value === "string" ? value : String(value);
};

const sanitizeReturnTo = (value?: string | null): string | null => {
  if (!value) {
    return null;
  }
  if (value.startsWith("/") && !value.startsWith("//")) {
    return value;
  }
  return null;
};

const resolveTokenStorage = (
  tokens: OAuth2Tokens,
  mode: AuthOAuthConfig["tokenStorage"],
): {
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  tokenType: string | null;
  tokenExpiresAt: Date | null;
  scopes: string[] | null;
} => {
  const storage = mode ?? "none";
  if (storage === "none") {
    return {
      accessToken: null,
      refreshToken: null,
      idToken: null,
      tokenType: null,
      tokenExpiresAt: null,
      scopes: null,
    };
  }

  if (storage === "refresh") {
    return {
      accessToken: null,
      refreshToken: tokens.refreshToken ?? null,
      idToken: null,
      tokenType: tokens.tokenType ?? null,
      tokenExpiresAt: null,
      scopes: tokens.scopes ?? null,
    };
  }

  return {
    accessToken: tokens.accessToken ?? null,
    refreshToken: tokens.refreshToken ?? null,
    idToken: tokens.idToken ?? null,
    tokenType: tokens.tokenType ?? null,
    tokenExpiresAt: tokens.accessTokenExpiresAt ?? null,
    scopes: tokens.scopes ?? null,
  };
};

export function createOAuthServices(options: {
  oauth?: AuthOAuthConfig;
  autoCreateOptions?: AutoCreateOrganizationOptions;
  beforeCreateUser?: BeforeCreateUserHook;
}) {
  const oauthConfig = normalizeOAuthConfig(options.oauth);

  return {
    /**
     * Create an OAuth state and persist it for the authorization redirect.
     */
    createOAuthState: function (
      this: AuthServiceContext,
      input: {
        providerId: string;
        redirectUri: string;
        returnTo?: string | null;
        sessionId?: string | null;
        link?: boolean;
      },
    ) {
      const ttlMs = oauthConfig?.stateTtlMs ?? DEFAULT_STATE_TTL_MS;
      const state = createOAuthState();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlMs);
      const returnTo = sanitizeReturnTo(input.returnTo);
      const sessionId = input.sessionId ?? "";
      const shouldLink = Boolean(input.link);

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("session", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", sessionId)),
          ),
        )
        .mutate(({ uow, retrieveResult: [session] }): OAuthStateResult => {
          if (shouldLink) {
            if (!session) {
              return { ok: false as const, code: "session_invalid" as const };
            }

            if (session.expiresAt < now) {
              uow.delete("session", session.id, (b) => b.check());
              return { ok: false as const, code: "session_invalid" as const };
            }
          }

          const linkUserId = shouldLink && session ? session.userId : null;

          uow.create("oauthState", {
            provider: input.providerId,
            state,
            codeVerifier: null,
            redirectUri: input.redirectUri,
            returnTo,
            linkUserId,
            createdAt: now,
            expiresAt,
          });

          return {
            ok: true as const,
            state,
            redirectUri: input.redirectUri,
            returnTo,
            expiresAt,
          };
        })
        .build();
    },

    /**
     * Handle the OAuth callback, linking or creating users and issuing a session.
     */
    handleOAuthCallback: function (
      this: AuthServiceContext,
      input: {
        providerId: string;
        state: string;
        tokens: OAuth2Tokens;
        userInfo: OAuth2UserInfo;
        rawProfile: Record<string, unknown> | null;
        provider?: OAuthProvider;
        requestSignUp?: boolean;
      },
    ) {
      const linkByEmail = oauthConfig?.linkByEmail ?? true;
      const tokenStorage = oauthConfig?.tokenStorage ?? "none";
      const requestSignUp = input.requestSignUp ?? false;

      const providerAccountId = coerceProviderAccountId(input.userInfo.id);
      const email = input.userInfo.email ?? null;

      if (!email) {
        return this.serviceTx(authSchema)
          .retrieve((uow) =>
            uow.findFirst("oauthState", (b) =>
              b.whereIndex("idx_oauth_state_state", (eb) => eb("state", "=", input.state)),
            ),
          )
          .mutate(({ uow, retrieveResult: [oauthState] }): OAuthCallbackResult => {
            if (!oauthState || oauthState.provider !== input.providerId) {
              return { ok: false as const, code: "invalid_state" as const };
            }

            uow.delete("oauthState", oauthState.id, (b) => b.check());

            return { ok: false as const, code: "email_required" as const };
          })
          .build();
      }

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("oauthState", (b) =>
              b
                .whereIndex("idx_oauth_state_state", (eb) => eb("state", "=", input.state))
                .join((j) =>
                  j.oauthStateLinkUser((b) => b.select(["id", "email", "role", "bannedAt"])),
                ),
            )
            .findFirst("oauthAccount", (b) =>
              b
                .whereIndex("idx_oauth_account_provider_account", (eb) =>
                  eb.and(
                    eb("provider", "=", input.providerId),
                    eb("providerAccountId", "=", providerAccountId),
                  ),
                )
                .join((j) =>
                  j.oauthAccountUser((b) => b.select(["id", "email", "role", "bannedAt"])),
                ),
            )
            .findFirst("user", (b) =>
              b.whereIndex("idx_user_email", (eb) => eb("email", "=", email)),
            ),
        )
        .mutate(
          ({
            uow,
            retrieveResult: [oauthState, oauthAccount, userByEmail],
          }): OAuthCallbackResult => {
            const now = new Date();

            if (!oauthState || oauthState.provider !== input.providerId) {
              return { ok: false as const, code: "invalid_state" as const };
            }

            if (oauthState.expiresAt < now) {
              uow.delete("oauthState", oauthState.id, (b) => b.check());
              return { ok: false as const, code: "invalid_state" as const };
            }

            uow.delete("oauthState", oauthState.id, (b) => b.check());

            const providerConfig = input.provider;
            if (!oauthAccount && providerConfig?.disableSignUp) {
              return { ok: false as const, code: "signup_disabled" as const };
            }

            const linkedUser = oauthState.oauthStateLinkUser ?? null;
            const accountUser = oauthAccount?.oauthAccountUser ?? null;

            let resolvedUser: {
              id: string;
              email: string;
              role: "user" | "admin";
              bannedAt?: Date | null;
            } | null = null;
            let createdUser = false;

            if (accountUser) {
              resolvedUser = {
                id: accountUser.id.valueOf(),
                email: accountUser.email,
                role: accountUser.role as "user" | "admin",
                bannedAt: accountUser.bannedAt ?? null,
              };
            } else if (linkedUser) {
              resolvedUser = {
                id: linkedUser.id.valueOf(),
                email: linkedUser.email,
                role: linkedUser.role as "user" | "admin",
                bannedAt: linkedUser.bannedAt ?? null,
              };
            } else if (
              linkByEmail &&
              userByEmail &&
              input.userInfo.email &&
              input.userInfo.emailVerified === true
            ) {
              resolvedUser = {
                id: userByEmail.id.valueOf(),
                email: userByEmail.email,
                role: userByEmail.role as "user" | "admin",
                bannedAt: userByEmail.bannedAt ?? null,
              };
            }

            if (!resolvedUser) {
              if (providerConfig?.disableImplicitSignUp && !requestSignUp) {
                return { ok: false as const, code: "signup_required" as const };
              }

              if (!email) {
                return { ok: false as const, code: "email_required" as const };
              }

              options.beforeCreateUser?.({ email, role: "user" });
              const userId = uow.create("user", {
                email,
                passwordHash: null,
                role: "user",
              });

              resolvedUser = {
                id: userId.valueOf(),
                email,
                role: "user",
                bannedAt: null,
              };
              createdUser = true;
            }

            if (resolvedUser.bannedAt) {
              return { ok: false as const, code: "user_banned" as const };
            }

            const tokenPayload = resolveTokenStorage(input.tokens, tokenStorage);
            const oauthAccountInput = {
              provider: input.providerId,
              providerAccountId,
              email,
              emailVerified: input.userInfo.emailVerified,
              image: typeof input.userInfo.image === "string" ? input.userInfo.image : null,
              accessToken: tokenPayload.accessToken,
              refreshToken: tokenPayload.refreshToken,
              idToken: tokenPayload.idToken,
              tokenType: tokenPayload.tokenType,
              tokenExpiresAt: tokenPayload.tokenExpiresAt,
              scopes: tokenPayload.scopes,
              rawProfile: input.rawProfile ?? null,
              updatedAt: now,
            };

            if (oauthAccount) {
              uow.update("oauthAccount", oauthAccount.id, (b) => b.set(oauthAccountInput).check());
            } else {
              uow.create("oauthAccount", {
                ...oauthAccountInput,
                userId: resolvedUser.id,
                createdAt: now,
              });
            }

            const autoOrganization = createdUser
              ? createAutoOrganization(uow, {
                  userId: resolvedUser.id,
                  email: resolvedUser.email,
                  now,
                  options: options.autoCreateOptions,
                })
              : null;

            const sessionExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
            const sessionId = uow.create("session", {
              userId: resolvedUser.id,
              activeOrganizationId: autoOrganization?.organization.id ?? null,
              expiresAt: sessionExpiresAt,
            });

            const userSummary = mapUserSummary({
              id: resolvedUser.id,
              email: resolvedUser.email,
              role: resolvedUser.role,
              bannedAt: resolvedUser.bannedAt ?? null,
            });

            if (createdUser) {
              uow.triggerHook("onUserCreated", {
                user: userSummary,
                actor: userSummary,
              });
            }

            uow.triggerHook("onSessionCreated", {
              session: {
                id: sessionId.valueOf(),
                user: userSummary,
                expiresAt: sessionExpiresAt,
                activeOrganizationId: autoOrganization?.organization.id ?? null,
              },
              actor: userSummary,
            });

            if (autoOrganization) {
              uow.triggerHook("onOrganizationCreated", {
                organization: autoOrganization.organization,
                actor: userSummary,
              });
              uow.triggerHook("onMemberAdded", {
                organization: autoOrganization.organization,
                member: autoOrganization.member,
                actor: userSummary,
              });
            }

            return {
              ok: true as const,
              sessionId: sessionId.valueOf(),
              userId: resolvedUser.id,
              email: resolvedUser.email,
              role: resolvedUser.role,
              returnTo: oauthState.returnTo ?? null,
            };
          },
        )
        .build();
    },
  };
}
