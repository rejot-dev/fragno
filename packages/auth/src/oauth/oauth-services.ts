import { generateId, type FragnoId } from "@fragno-dev/db/schema";

import type { DatabaseServiceContext } from "@fragno-dev/db";

import type { AuthActor, ValidatedCredential } from "../auth/types";
import {
  DEFAULT_EMAIL_VERIFICATION_REQUEST_COOLDOWN_SECONDS,
  evaluateCredentialEligibility,
  planEmailVerificationRequest,
  type AuthEmailVerificationConfig,
  type EmailVerificationRequestPlan,
} from "../email-verification";
import type { AuthHooksMap, BeforeCreateUserHook } from "../hooks";
import { authSchema } from "../schema";
import {
  normalizeCredentialSeed,
  parseCredentialSeed,
  resolveCredentialSeedFromMembers,
  type CredentialSeedInput,
} from "../session/session-seed";
import {
  createAutoOrganization,
  type AutoCreateOrganizationOptions,
} from "../user/auto-organization";
import { normalizeAuthEmail } from "../user/email";
import { recordEmailVerificationRequest } from "../user/email-verification-services";
import { mapUserSummary } from "../user/summary";
import type { AnyOAuthProvider, AuthOAuthConfig, OAuth2Tokens, OAuth2UserInfo } from "./types";
import { createOAuthState, DEFAULT_STATE_TTL_MS, normalizeOAuthConfig } from "./utils";

export type OAuthStateResult =
  | {
      ok: true;
      state: string;
      redirectUri: string;
      returnTo: string | null;
    }
  | {
      ok: false;
      code: "credential_invalid";
    };

export type OAuthCallbackResult =
  | {
      ok: true;
      credential: ValidatedCredential;
      credentialToken: string;
      expiresAt: Date;
      activeOrganizationId: string | null;
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
        | "email_already_exists"
        | "user_banned"
        | "email_verification_required";
    };

type AuthServiceContext = DatabaseServiceContext<AuthHooksMap>;
type CredentialSeedMemberRow = {
  createdAt: Date;
  organizationMemberOrganization?: {
    id: unknown;
    deletedAt: Date | null;
  } | null;
};

type SeedableUserRow = {
  id: FragnoId;
  email: string;
  role: string;
  bannedAt?: Date | null;
  emailVerifiedAt: Date | null;
  emailVerificationRequestedAt: Date | null;
  userOrganizationMembers?: CredentialSeedMemberRow | CredentialSeedMemberRow[] | null;
};

const normalizeMany = <T>(value: T | T[] | null | undefined): T[] => {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
};

const mapCredentialSeedMembers = (
  value: CredentialSeedMemberRow | CredentialSeedMemberRow[] | null | undefined,
) => {
  return normalizeMany(value).map((member) => ({
    createdAt: member.createdAt,
    organization: member.organizationMemberOrganization ?? null,
  }));
};

type UserWithCredentialSeedMembers = {
  userOrganizationMembers?: CredentialSeedMemberRow | CredentialSeedMemberRow[] | null;
};

const collectCredentialSeedMembers = (
  rows: Array<UserWithCredentialSeedMembers | null | undefined>,
) => {
  return rows.flatMap((row) => (row ? mapCredentialSeedMembers(row.userOrganizationMembers) : []));
};

const collectOrganizationIdsFromSeedMembers = (
  members: ReturnType<typeof collectCredentialSeedMembers>,
) =>
  Array.from(
    new Set(
      members.flatMap((member) =>
        member.organization && !member.organization.deletedAt
          ? [String(member.organization.id)]
          : [],
      ),
    ),
  );

const toResolvedUser = (rows: Array<SeedableUserRow | null | undefined>) => {
  const first = rows.find((row): row is SeedableUserRow => Boolean(row));
  if (!first) {
    return null;
  }

  return {
    id: first.id.valueOf(),
    storageId: first.id,
    email: first.email,
    role: first.role as "user" | "admin",
    bannedAt: first.bannedAt ?? null,
    emailVerifiedAt: first.emailVerifiedAt,
    emailVerificationRequestedAt: first.emailVerificationRequestedAt ?? null,
    members: collectCredentialSeedMembers(rows),
  };
};

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
  emailVerification?: AuthEmailVerificationConfig;
}) {
  const oauthConfig = normalizeOAuthConfig(options.oauth);
  const emailVerificationRequestCooldownSeconds =
    options.emailVerification?.requestCooldownSeconds ??
    DEFAULT_EMAIL_VERIFICATION_REQUEST_COOLDOWN_SECONDS;

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
        actor?: AuthActor | null;
        link?: boolean;
        auth?: CredentialSeedInput | null;
      },
    ) {
      const ttlMs = oauthConfig?.stateTtlMs ?? DEFAULT_STATE_TTL_MS;
      const state = createOAuthState();
      const returnTo = sanitizeReturnTo(input.returnTo);
      const shouldLink = Boolean(input.link);
      const credentialSeed = normalizeCredentialSeed(input.auth);

      return this.serviceTx(authSchema)
        .mutate(({ uow }): OAuthStateResult => {
          if (shouldLink && !input.actor) {
            return { ok: false as const, code: "credential_invalid" as const };
          }

          const linkUserId = shouldLink ? (input.actor?.userId ?? null) : null;

          uow.create("oauthState", {
            provider: input.providerId,
            state,
            codeVerifier: null,
            redirectUri: input.redirectUri,
            returnTo,
            sessionSeed: credentialSeed,
            linkUserId,
            createdAt: uow.now(),
            expiresAt: uow.now().plus({ ms: ttlMs }),
          });

          return {
            ok: true as const,
            state,
            redirectUri: input.redirectUri,
            returnTo,
          };
        })
        .build();
    },

    /**
     * Handle the OAuth callback, linking or creating users and issuing a credential.
     */
    handleOAuthCallback: function (
      this: AuthServiceContext,
      input: {
        providerId: string;
        state: string;
        tokens: OAuth2Tokens;
        userInfo: OAuth2UserInfo;
        rawProfile: Record<string, unknown> | null;
        provider?: AnyOAuthProvider;
        requestSignUp?: boolean;
      },
    ) {
      const linkByEmail = oauthConfig?.linkByEmail ?? true;
      const tokenStorage = oauthConfig?.tokenStorage ?? "none";
      const requestSignUp = input.requestSignUp ?? false;

      const providerAccountId = coerceProviderAccountId(input.userInfo.id);
      const email = input.userInfo.email ? normalizeAuthEmail(input.userInfo.email) : null;

      if (!email) {
        return this.serviceTx(authSchema)
          .retrieve((uow) =>
            uow
              .findFirst("oauthState", (b) =>
                b.whereIndex("idx_oauth_state_state", (eb) => eb("state", "=", input.state)),
              )
              .findFirst("oauthState", (b) =>
                b
                  .whereIndex("idx_oauth_state_state_expires_at", (eb) =>
                    eb.and(eb("state", "=", input.state), eb("expiresAt", ">", eb.now())),
                  )
                  .select(["id"]),
              ),
          )
          .mutate(({ uow, retrieveResult: [oauthState, validOauthState] }): OAuthCallbackResult => {
            if (!oauthState || oauthState.provider !== input.providerId) {
              return { ok: false as const, code: "invalid_state" as const };
            }

            if (validOauthState?.id.valueOf() !== oauthState.id.valueOf()) {
              uow.delete("oauthState", oauthState.id, (b) => b.check());
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
            .find("oauthState", (b) =>
              b
                .whereIndex("idx_oauth_state_state", (eb) => eb("state", "=", input.state))
                .joinOne("oauthStateLinkUser", "user", (user) =>
                  user
                    .onIndex("primary", (eb) => eb("id", "=", eb.parent("linkUserId")))
                    .select([
                      "id",
                      "email",
                      "role",
                      "bannedAt",
                      "emailVerifiedAt",
                      "emailVerificationRequestedAt",
                    ])
                    .joinMany("userOrganizationMembers", "organizationMember", (member) =>
                      member
                        .onIndex("idx_org_member_user", (eb) => eb("userId", "=", eb.parent("id")))
                        .select(["createdAt"])
                        .joinOne("organizationMemberOrganization", "organization", (organization) =>
                          organization
                            .onIndex("primary", (eb) => eb("id", "=", eb.parent("organizationId")))
                            .select(["id", "deletedAt"]),
                        ),
                    ),
                ),
            )
            .find("oauthAccount", (b) =>
              b
                .whereIndex("idx_oauth_account_provider_account", (eb) =>
                  eb.and(
                    eb("provider", "=", input.providerId),
                    eb("providerAccountId", "=", providerAccountId),
                  ),
                )
                .joinOne("oauthAccountUser", "user", (user) =>
                  user
                    .onIndex("primary", (eb) => eb("id", "=", eb.parent("userId")))
                    .select([
                      "id",
                      "email",
                      "role",
                      "bannedAt",
                      "emailVerifiedAt",
                      "emailVerificationRequestedAt",
                    ])
                    .joinMany("userOrganizationMembers", "organizationMember", (member) =>
                      member
                        .onIndex("idx_org_member_user", (eb) => eb("userId", "=", eb.parent("id")))
                        .select(["createdAt"])
                        .joinOne("organizationMemberOrganization", "organization", (organization) =>
                          organization
                            .onIndex("primary", (eb) => eb("id", "=", eb.parent("organizationId")))
                            .select(["id", "deletedAt"]),
                        ),
                    ),
                ),
            )
            .find("user", (b) =>
              b
                .whereIndex("idx_user_email", (eb) => eb("email", "=", email))
                .joinMany("userOrganizationMembers", "organizationMember", (member) =>
                  member
                    .onIndex("idx_org_member_user", (eb) => eb("userId", "=", eb.parent("id")))
                    .select(["createdAt"])
                    .joinOne("organizationMemberOrganization", "organization", (organization) =>
                      organization
                        .onIndex("primary", (eb) => eb("id", "=", eb.parent("organizationId")))
                        .select(["id", "deletedAt"]),
                    ),
                ),
            )
            .find("oauthState", (b) =>
              b
                .whereIndex("idx_oauth_state_state_expires_at", (eb) =>
                  eb.and(eb("state", "=", input.state), eb("expiresAt", ">", eb.now())),
                )
                .select(["id"])
                .joinOne("oauthStateLinkUser", "user", (user) =>
                  user
                    .onIndex("idx_user_id_email_verification_request", (eb) =>
                      eb.and(
                        eb("id", "=", eb.parent("linkUserId")),
                        eb.or(
                          eb.isNull("emailVerificationRequestedAt"),
                          eb(
                            "emailVerificationRequestedAt",
                            "<=",
                            eb.now().plus({
                              seconds: -emailVerificationRequestCooldownSeconds,
                            }),
                          ),
                        ),
                      ),
                    )
                    .select(["id"]),
                ),
            )
            .find("oauthAccount", (b) =>
              b
                .whereIndex("idx_oauth_account_provider_account", (eb) =>
                  eb.and(
                    eb("provider", "=", input.providerId),
                    eb("providerAccountId", "=", providerAccountId),
                  ),
                )
                .select(["id"])
                .joinOne("oauthAccountUser", "user", (user) =>
                  user
                    .onIndex("idx_user_id_email_verification_request", (eb) =>
                      eb.and(
                        eb("id", "=", eb.parent("userId")),
                        eb.or(
                          eb.isNull("emailVerificationRequestedAt"),
                          eb(
                            "emailVerificationRequestedAt",
                            "<=",
                            eb.now().plus({
                              seconds: -emailVerificationRequestCooldownSeconds,
                            }),
                          ),
                        ),
                      ),
                    )
                    .select(["id"]),
                ),
            )
            .findFirst("user", (b) =>
              b
                .whereIndex("idx_user_email_verification_request", (eb) =>
                  eb.and(
                    eb("email", "=", email),
                    eb.or(
                      eb.isNull("emailVerificationRequestedAt"),
                      eb(
                        "emailVerificationRequestedAt",
                        "<=",
                        eb.now().plus({
                          seconds: -emailVerificationRequestCooldownSeconds,
                        }),
                      ),
                    ),
                  ),
                )
                .select(["id"]),
            ),
        )
        .mutate(
          ({
            uow,
            retrieveResult: [
              oauthStates,
              oauthAccounts,
              usersByEmail,
              validOauthStates,
              requestEligibleOauthAccounts,
              requestEligibleUserByEmail,
            ],
          }): OAuthCallbackResult => {
            const now = new Date();
            const oauthState = oauthStates[0] ?? null;
            const oauthAccount = oauthAccounts[0] ?? null;
            const validOauthState = validOauthStates[0] ?? null;

            if (!oauthState || oauthState.provider !== input.providerId) {
              return { ok: false as const, code: "invalid_state" as const };
            }

            if (validOauthState?.id.valueOf() !== oauthState.id.valueOf()) {
              uow.delete("oauthState", oauthState.id, (b) => b.check());
              return { ok: false as const, code: "invalid_state" as const };
            }

            uow.delete("oauthState", oauthState.id, (b) => b.check());

            const requestEligibleUserIds = new Set<string>();
            const requestEligibleLinkedUser = validOauthState.oauthStateLinkUser;
            if (requestEligibleLinkedUser) {
              requestEligibleUserIds.add(requestEligibleLinkedUser.id.valueOf());
            }
            const requestEligibleAccountUser =
              requestEligibleOauthAccounts[0]?.oauthAccountUser ?? null;
            if (requestEligibleAccountUser) {
              requestEligibleUserIds.add(requestEligibleAccountUser.id.valueOf());
            }
            if (requestEligibleUserByEmail) {
              requestEligibleUserIds.add(requestEligibleUserByEmail.id.valueOf());
            }

            const providerConfig = input.provider;
            if (!oauthAccount && providerConfig?.disableSignUp) {
              return { ok: false as const, code: "signup_disabled" as const };
            }

            const sessionSeed = parseCredentialSeed(
              (oauthState as { sessionSeed?: unknown }).sessionSeed,
            );
            const linkedUser = toResolvedUser(
              oauthStates.map((state) => state.oauthStateLinkUser ?? null),
            );
            const accountUser = toResolvedUser(
              oauthAccounts.map((account) => account.oauthAccountUser ?? null),
            );
            const existingUserByEmail = toResolvedUser(usersByEmail);

            let resolvedUser: {
              id: string;
              storageId: FragnoId;
              email: string;
              role: "user" | "admin";
              bannedAt?: Date | null;
              emailVerifiedAt: Date | null;
              emailVerificationRequestedAt: Date | null;
              members: ReturnType<typeof mapCredentialSeedMembers>;
            } | null = null;
            let createdUser = false;
            let createdUserEmailVerificationRequest: EmailVerificationRequestPlan | null = null;

            if (accountUser) {
              resolvedUser = accountUser;
            } else if (linkedUser) {
              resolvedUser = linkedUser;
            } else if (
              linkByEmail &&
              existingUserByEmail &&
              input.userInfo.email &&
              input.userInfo.emailVerified
            ) {
              resolvedUser = existingUserByEmail;
            }

            if (!resolvedUser) {
              if (providerConfig?.disableImplicitSignUp && !requestSignUp) {
                return { ok: false as const, code: "signup_required" as const };
              }

              if (!email) {
                return { ok: false as const, code: "email_required" as const };
              }

              if (existingUserByEmail) {
                return { ok: false as const, code: "email_already_exists" as const };
              }

              const role = options.beforeCreateUser?.({ email, role: "user" })?.role ?? "user";
              const emailVerifiedAt = input.userInfo.emailVerified ? now : null;
              const userId = generateId(authSchema, "user");
              const emailVerificationRequest = planEmailVerificationRequest(
                {
                  id: userId.valueOf(),
                  email,
                  role,
                  bannedAt: null,
                  emailVerifiedAt,
                },
                options.emailVerification,
                { requestCooldownElapsed: true },
              );
              uow.create("user", {
                id: userId,
                email,
                passwordHash: null,
                role,
                emailVerifiedAt,
                emailVerificationRequestedAt:
                  emailVerificationRequest.status === "requested" ? uow.now() : null,
              });

              resolvedUser = {
                id: userId.valueOf(),
                storageId: userId,
                email,
                role,
                bannedAt: null,
                emailVerifiedAt,
                emailVerificationRequestedAt: null,
                members: [],
              };
              createdUser = true;
              createdUserEmailVerificationRequest = emailVerificationRequest;
            }

            if (resolvedUser.bannedAt) {
              return { ok: false as const, code: "user_banned" as const };
            }

            const providerVerifiedCurrentEmail =
              input.userInfo.emailVerified && resolvedUser.email === email;
            const emailVerifiedAt =
              resolvedUser.emailVerifiedAt ?? (providerVerifiedCurrentEmail ? now : null);
            const emailVerificationEstablished = createdUser
              ? emailVerifiedAt !== null
              : resolvedUser.emailVerifiedAt === null && emailVerifiedAt !== null;

            if (!createdUser && emailVerificationEstablished && emailVerifiedAt) {
              uow.update("user", resolvedUser.storageId, (b) => b.set({ emailVerifiedAt }).check());
            }

            resolvedUser = {
              ...resolvedUser,
              emailVerifiedAt,
            };

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
              updatedAt: uow.now(),
            };

            if (oauthAccount) {
              uow.update("oauthAccount", oauthAccount.id, (b) => b.set(oauthAccountInput).check());
            } else {
              uow.create("oauthAccount", {
                ...oauthAccountInput,
                userId: resolvedUser.id,
                createdAt: uow.now(),
              });
            }

            const autoOrganization = createdUser
              ? createAutoOrganization(uow, {
                  userId: resolvedUser.id,
                  email: resolvedUser.email,
                  options: options.autoCreateOptions,
                })
              : null;

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
                emailVerifiedAt: resolvedUser.emailVerifiedAt?.toISOString() ?? null,
              });
            }

            const emailVerificationRequest =
              createdUser && createdUserEmailVerificationRequest
                ? createdUserEmailVerificationRequest
                : planEmailVerificationRequest(
                    {
                      ...userSummary,
                      bannedAt: resolvedUser.bannedAt ?? null,
                      emailVerifiedAt: resolvedUser.emailVerifiedAt,
                    },
                    options.emailVerification,
                    { requestCooldownElapsed: requestEligibleUserIds.has(resolvedUser.id) },
                  );
            recordEmailVerificationRequest(uow, {
              plan: emailVerificationRequest,
              target: createdUser
                ? { kind: "new" }
                : { kind: "persisted", userId: resolvedUser.storageId },
              user: userSummary,
              reason: "oauth",
            });

            if (emailVerificationEstablished && emailVerifiedAt) {
              uow.triggerHook("onUserEmailVerified", {
                user: userSummary,
                actor: userSummary,
                emailVerifiedAt: emailVerifiedAt.toISOString(),
              });
            }

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

            const eligibility = evaluateCredentialEligibility(
              {
                ...userSummary,
                emailVerifiedAt: resolvedUser.emailVerifiedAt,
              },
              options.emailVerification,
            );
            if (!eligibility.ok) {
              return eligibility;
            }

            const existingOrganizationIds = collectOrganizationIdsFromSeedMembers(
              resolvedUser.members,
            );
            const resolvedCredentialSeed = resolveCredentialSeedFromMembers(
              resolvedUser.members,
              sessionSeed,
            );
            const activeOrganizationId =
              resolvedCredentialSeed.activeOrganizationId ??
              autoOrganization?.organization.id ??
              null;
            const sessionExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
            const databaseSessionExpiresAt = uow.now().plus({ days: 30 });
            const credentialId = uow.create("session", {
              userId: resolvedUser.id,
              activeOrganizationId,
              expiresAt: databaseSessionExpiresAt,
            });

            uow.triggerHook("onCredentialIssued", {
              credential: {
                id: credentialId.valueOf(),
                user: userSummary,
                expiresAt: databaseSessionExpiresAt,
                activeOrganizationId,
              },
              actor: userSummary,
            });

            const credential = {
              id: credentialId.valueOf(),
              expiresAt: sessionExpiresAt,
              activeOrganizationId,
              organizationIds: autoOrganization
                ? Array.from(
                    new Set([...existingOrganizationIds, autoOrganization.organization.id]),
                  )
                : existingOrganizationIds,
              user: {
                id: resolvedUser.id,
                email: resolvedUser.email,
                role: resolvedUser.role,
              },
            };

            return {
              ok: true as const,
              credential,
              credentialToken: credential.id,
              expiresAt: credential.expiresAt,
              activeOrganizationId: credential.activeOrganizationId,
              userId: credential.user.id,
              email: credential.user.email,
              role: credential.user.role,
              returnTo: oauthState.returnTo ?? null,
            };
          },
        )
        .build();
    },
  };
}
