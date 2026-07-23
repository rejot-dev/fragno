import { generateId } from "@fragno-dev/db/schema";
import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";
import { isUniqueConstraintError, type DatabaseServiceContext } from "@fragno-dev/db";

import type { authFragmentDefinition } from "..";
import { buildIssuedAuthResponse, issuedAuthSchema } from "../auth/response-auth";
import {
  issueSessionBackedAuthCredential,
  resolveAccessTokenConfig,
  resolveBackingSessionCredential,
} from "../auth/session-access-token";
import type { AuthActor } from "../auth/types";
import {
  DEFAULT_EMAIL_VERIFICATION_REQUEST_COOLDOWN_SECONDS,
  evaluateCredentialEligibility,
  planEmailVerificationRequest,
  type AuthEmailVerificationConfig,
} from "../email-verification";
import type { AuthHooksMap, BeforeCreateUserHook } from "../hooks";
import { authSchema } from "../schema";
import {
  sessionCredentialOwnerSelect,
  validateSessionCredentialOwner,
} from "../session/session-credential-validator";
import { resolveCredentialSeedFromMembers, credentialSeedSchema } from "../session/session-seed";
import {
  createAutoOrganization,
  resolveAutoOrganizationInput,
  type AutoCreateOrganizationOptions,
} from "./auto-organization";
import { authEmailSchema, normalizeAuthEmail } from "./email";
import { recordEmailVerificationRequest } from "./email-verification-services";
import { hashPassword, verifyPassword } from "./password";
import { mapUserSummary } from "./summary";

type AuthServiceContext = DatabaseServiceContext<AuthHooksMap>;

const authSignUpDataSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("authenticated"),
    auth: issuedAuthSchema,
    userId: z.string(),
    email: z.string(),
    role: z.enum(["user", "admin"]),
  }),
  z.object({
    status: z.literal("email_verification_required"),
    userId: z.string(),
    email: z.string(),
    role: z.enum(["user", "admin"]),
  }),
]);

type CredentialSeedMemberRow = {
  createdAt: Date;
  organizationMemberOrganization?: {
    id: unknown;
    deletedAt: Date | null;
  } | null;
};

const normalizeMany = <T>(value: T | T[] | null | undefined): T[] => {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
};

const normalizeRole = (role: string): "user" | "admin" => (role === "admin" ? "admin" : "user");

type UserWithCredentialSeedMembers = {
  userOrganizationMembers?: CredentialSeedMemberRow | CredentialSeedMemberRow[] | null;
};

const collectCredentialSeedMembers = (rows: UserWithCredentialSeedMembers[]) => {
  return rows.flatMap((user) =>
    normalizeMany(user.userOrganizationMembers).map((member) => ({
      createdAt: member.createdAt,
      organization: member.organizationMemberOrganization ?? null,
    })),
  );
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

export function createUserServices(
  options: AutoCreateOrganizationOptions | undefined,
  beforeCreateUser: BeforeCreateUserHook | undefined,
  emailVerification: AuthEmailVerificationConfig | undefined,
) {
  const resolveCreateUserRole = (email: string, role: "user" | "admin") =>
    beforeCreateUser?.({ email, role })?.role ?? role;

  const createUserUnvalidated = function (
    this: AuthServiceContext,
    email: string,
    passwordHash: string,
    role: "user" | "admin" = "user",
    autoCreateOptions?: AutoCreateOrganizationOptions,
  ) {
    const normalizedEmail = normalizeAuthEmail(email);

    return this.serviceTx(authSchema)
      .mutate(({ uow }) => {
        const resolvedRole = resolveCreateUserRole(normalizedEmail, role);
        const id = uow.create("user", {
          email: normalizedEmail,
          passwordHash,
          role: resolvedRole,
        });
        const userSummary = mapUserSummary({
          id: id.valueOf(),
          email: normalizedEmail,
          role: resolvedRole,
          bannedAt: null,
        });

        const autoOrganization = createAutoOrganization(uow, {
          userId: id.valueOf(),
          email: normalizedEmail,
          options: autoCreateOptions ?? options,
        });

        uow.triggerHook("onUserCreated", {
          user: userSummary,
          actor: null,
          emailVerifiedAt: null,
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
          id: id.valueOf(),
          email: normalizedEmail,
          role: resolvedRole,
        };
      })
      .build();
  };

  const services = {
    /**
     * Create a user without a preflight email lookup or session creation.
     * The schema's unique email index still rejects duplicates.
     */
    createUserUnvalidated,
    /**
     * Fetch a user by email with password hash metadata.
     */
    getUserByEmail: function (this: AuthServiceContext, email: string) {
      const normalizedEmail = normalizeAuthEmail(email);

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("user", (b) =>
            b.whereIndex("idx_user_email", (eb) => eb("email", "=", normalizedEmail)),
          ),
        )
        .transformRetrieve(([user]) =>
          user
            ? {
                id: user.id.valueOf(),
                email: user.email,
                passwordHash: user.passwordHash ?? null,
                role: normalizeRole(user.role),
                emailVerifiedAt: user.emailVerifiedAt ?? null,
              }
            : null,
        )
        .build();
    },
    /**
     * Set a user's role without actor or credential checks.
     */
    setUserRole: function (this: AuthServiceContext, userId: string, role: "user" | "admin") {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("user", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId))),
        )
        .mutate(({ uow, retrieveResult: [user] }) => {
          uow.update("user", userId, (b) => b.set({ role }));

          if (user) {
            uow.triggerHook("onUserRoleUpdated", {
              user: mapUserSummary({
                id: userId,
                email: user.email,
                role,
                bannedAt: user.bannedAt ?? null,
              }),
              actor: null,
            });
          }
          return { success: true };
        })
        .build();
    },
    /**
     * Update a user's password hash without session enforcement.
     */
    updateUserPassword: function (this: AuthServiceContext, userId: string, passwordHash: string) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("user", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId))),
        )
        .mutate(({ uow, retrieveResult: [user] }) => {
          uow.update("user", userId, (b) => b.set({ passwordHash }));

          if (user) {
            uow.triggerHook("onUserPasswordChanged", {
              user: mapUserSummary({
                id: userId,
                email: user.email,
                role: user.role,
                bannedAt: user.bannedAt ?? null,
              }),
              actor: null,
            });
          }
          return { success: true };
        })
        .build();
    },
    /**
     * Create a user and issue the initial auth credential for email/password sign-up.
     */
    signUp: function (
      this: AuthServiceContext,
      email: string,
      passwordHash: string,
      autoCreateOptions?: AutoCreateOrganizationOptions,
    ) {
      const normalizedEmail = normalizeAuthEmail(email);

      const userId = generateId(authSchema, "user");
      const effectiveAutoCreateOptions = autoCreateOptions ?? options;
      const autoOrganizationInput = resolveAutoOrganizationInput({
        userId: userId.valueOf(),
        email: normalizedEmail,
        options: effectiveAutoCreateOptions,
      });
      const autoOrganizationSlug = autoOrganizationInput?.slug ?? "";

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("user", (b) =>
              b
                .whereIndex("idx_user_email", (eb) => eb("email", "=", normalizedEmail))
                .select(["id"]),
            )
            .findFirst("organization", (b) =>
              b.whereIndex("idx_organization_slug", (eb) => eb("slug", "=", autoOrganizationSlug)),
            ),
        )
        .mutate(({ uow, retrieveResult: [existingUser, existingAutoOrganization] }) => {
          if (existingUser) {
            return { ok: false as const, code: "email_already_exists" as const };
          }

          if (autoOrganizationInput && existingAutoOrganization) {
            return { ok: false as const, code: "organization_slug_taken" as const };
          }

          const now = new Date();
          const credentialExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000);
          const role = resolveCreateUserRole(normalizedEmail, "user");
          const userSummary = mapUserSummary({
            id: userId.valueOf(),
            email: normalizedEmail,
            role,
            bannedAt: null,
          });
          const emailVerificationRequest = planEmailVerificationRequest(
            {
              ...userSummary,
              bannedAt: null,
              emailVerifiedAt: null,
            },
            emailVerification,
            { requestCooldownElapsed: true },
          );

          uow.create("user", {
            id: userId,
            email: normalizedEmail,
            passwordHash,
            role,
            emailVerificationRequestedAt:
              emailVerificationRequest.status === "requested" ? uow.now() : null,
          });

          const autoOrganization = createAutoOrganization(uow, {
            userId: userId.valueOf(),
            email: normalizedEmail,
            options: effectiveAutoCreateOptions,
            autoOrganizationInput,
          });

          uow.triggerHook("onUserCreated", {
            user: userSummary,
            actor: userSummary,
            emailVerifiedAt: null,
          });
          recordEmailVerificationRequest(uow, {
            plan: emailVerificationRequest,
            target: { kind: "new" },
            user: userSummary,
            reason: "sign_up",
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

          const eligibility = evaluateCredentialEligibility(
            {
              ...userSummary,
              emailVerifiedAt: null,
            },
            emailVerification,
          );
          if (!eligibility.ok) {
            return {
              ok: true as const,
              status: "email_verification_required" as const,
              user: userSummary,
            };
          }

          const activeOrganizationId = autoOrganization?.organization.id ?? null;
          const sessionExpiresAt = uow.now().plus({ days: 30 });
          const credentialId = uow.create("session", {
            userId,
            activeOrganizationId,
            expiresAt: sessionExpiresAt,
          });

          uow.triggerHook("onCredentialIssued", {
            credential: {
              id: credentialId.valueOf(),
              user: userSummary,
              expiresAt: sessionExpiresAt,
              activeOrganizationId,
            },
            actor: userSummary,
          });

          return {
            ok: true as const,
            status: "authenticated" as const,
            credential: {
              id: credentialId.valueOf(),
              expiresAt: credentialExpiresAt,
              activeOrganizationId,
              organizationIds: autoOrganization ? [autoOrganization.organization.id] : [],
              user: {
                id: userId.valueOf(),
                email,
                role,
              },
            },
          };
        })
        .build();
    },
    /**
     * Update a user's role with actor-based admin enforcement.
     */
    updateUserRole: function (
      this: AuthServiceContext,
      actor: AuthActor,
      userId: string,
      role: "user" | "admin",
    ) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("user", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId))),
        )
        .mutate(({ uow, retrieveResult: [user] }) => {
          if (actor.role !== "admin") {
            return { ok: false as const, code: "permission_denied" as const };
          }

          uow.update("user", userId, (b) => b.set({ role }));

          if (user) {
            const actorSummary = mapUserSummary({
              id: actor.userId,
              email: actor.email,
              role: actor.role,
              bannedAt: null,
            });
            uow.triggerHook("onUserRoleUpdated", {
              user: mapUserSummary({
                id: userId,
                email: user.email,
                role,
                bannedAt: user.bannedAt ?? null,
              }),
              actor: actorSummary,
            });
          }
          return { ok: true as const };
        })
        .build();
    },
    /**
     * Change the authenticated actor's password.
     */
    changePassword: function (this: AuthServiceContext, actor: AuthActor, passwordHash: string) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("user", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", actor.userId)),
          ),
        )
        .mutate(({ uow, retrieveResult: [user] }) => {
          if (!user) {
            return { ok: false as const, code: "credential_invalid" as const };
          }

          uow.update("user", actor.userId, (b) => b.set({ passwordHash }).check());
          const actorSummary = mapUserSummary({
            id: actor.userId,
            email: actor.email,
            role: actor.role,
            bannedAt: user.bannedAt ?? null,
          });
          uow.triggerHook("onUserPasswordChanged", {
            user: actorSummary,
            actor: actorSummary,
          });
          return { ok: true as const };
        })
        .build();
    },
    /**
     * Update a user role from the current credential context.
     */
    updateUserRoleForCredential: function (
      this: AuthServiceContext,
      credentialToken: string,
      userId: string,
      role: "user" | "admin",
    ) {
      const now = new Date();
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("session", (b) =>
              b
                .whereIndex("primary", (eb) => eb("id", "=", credentialToken))
                .joinOne("sessionOwner", "user", (owner) =>
                  owner
                    .onIndex("primary", (eb) => eb("id", "=", eb.parent("userId")))
                    .select(sessionCredentialOwnerSelect),
                ),
            )
            .findFirst("user", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId))),
        )
        .mutate(({ uow, retrieveResult: [session, user] }) => {
          if (!session) {
            return { ok: false as const, code: "credential_invalid" as const };
          }

          if (session.expiresAt < now) {
            uow.delete("session", session.id, (b) => b.check());
            return { ok: false as const, code: "credential_invalid" as const };
          }

          const validation = validateSessionCredentialOwner(
            session.sessionOwner,
            emailVerification,
          );
          if (!validation.ok) {
            return validation;
          }

          if (validation.user.role !== "admin") {
            return { ok: false as const, code: "permission_denied" as const };
          }

          uow.update("user", userId, (b) => b.set({ role }));

          if (user) {
            uow.triggerHook("onUserRoleUpdated", {
              user: mapUserSummary({
                id: userId,
                email: user.email,
                role,
                bannedAt: user.bannedAt ?? null,
              }),
              actor: validation.user,
            });
          }
          return { ok: true as const };
        })
        .build();
    },
    /**
     * Change the current user's password from the current credential context.
     */
    changePasswordForCredential: function (
      this: AuthServiceContext,
      credentialToken: string,
      passwordHash: string,
    ) {
      const now = new Date();
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("session", (b) =>
            b
              .whereIndex("primary", (eb) => eb("id", "=", credentialToken))
              .joinOne("sessionOwner", "user", (owner) =>
                owner
                  .onIndex("primary", (eb) => eb("id", "=", eb.parent("userId")))
                  .select(sessionCredentialOwnerSelect),
              ),
          ),
        )
        .mutate(({ uow, retrieveResult: [session] }) => {
          if (!session) {
            return { ok: false as const, code: "credential_invalid" as const };
          }

          if (session.expiresAt < now) {
            uow.delete("session", session.id, (b) => b.check());
            return { ok: false as const, code: "credential_invalid" as const };
          }

          const validation = validateSessionCredentialOwner(
            session.sessionOwner,
            emailVerification,
          );
          if (!validation.ok) {
            return validation;
          }

          uow.update("user", validation.owner.id, (b) => b.set({ passwordHash }).check());
          uow.triggerHook("onUserPasswordChanged", {
            user: validation.user,
            actor: validation.user,
          });
          return { ok: true as const };
        })
        .build();
    },
  };

  return services;
}

export const userActionsRoutesFactory = defineRoutes<typeof authFragmentDefinition>().create(
  ({ services, config, defineRoute }) => {
    const emailAndPasswordEnabled = config.emailAndPassword?.enabled !== false;
    const accessTokens = resolveAccessTokenConfig(config.authentication?.accessTokens);
    const emailVerificationRequestCooldownSeconds =
      config.emailVerification?.requestCooldownSeconds ??
      DEFAULT_EMAIL_VERIFICATION_REQUEST_COOLDOWN_SECONDS;

    return [
      defineRoute({
        method: "PATCH",
        path: "/users/:userId/role",
        inputSchema: z.object({
          role: z.enum(["user", "admin"]),
        }),
        outputSchema: z.object({
          success: z.boolean(),
        }),
        errorCodes: ["invalid_input", "credential_invalid", "permission_denied"],
        handler: async function ({ input, pathParams, headers }, { json, error }) {
          const { role } = await input.valid();
          const { userId } = pathParams;

          const credential = await resolveBackingSessionCredential({
            headers,
            cookieOptions: config.cookieOptions,
            accessTokens,
          });
          if (!credential.ok) {
            return error(
              {
                message:
                  credential.reason === "malformed"
                    ? "Malformed authentication"
                    : "Authentication required",
                code: "credential_invalid",
              },
              credential.reason === "invalid" ? 401 : 400,
            );
          }

          const credentialToken = credential.credential.token;

          const [result] = await this.handlerTx()
            .withServiceCalls(() => [
              services.updateUserRoleForCredential(credentialToken, userId, role),
            ])
            .execute();

          if (!result.ok) {
            if (result.code === "permission_denied") {
              return error({ message: "Unauthorized", code: "permission_denied" }, 401);
            }

            return error({ message: "Invalid credential", code: "credential_invalid" }, 401);
          }

          return json({ success: true });
        },
      }),

      defineRoute({
        method: "POST",
        path: "/sign-up",
        inputSchema: z.object({
          email: authEmailSchema,
          password: z.string().min(8).max(100),
        }),
        outputSchema: authSignUpDataSchema,
        errorCodes: [
          "email_already_exists",
          "invalid_input",
          "email_password_disabled",
          "organization_slug_taken",
        ],
        handler: async function ({ input }, { error }) {
          if (!emailAndPasswordEnabled) {
            return error(
              { message: "Email/password auth is disabled", code: "email_password_disabled" },
              403,
            );
          }

          const { email, password } = await input.valid();

          const passwordHash = await hashPassword(password);

          const signUpTx = this.handlerTx().withServiceCalls(() => [
            services.signUp(email, passwordHash),
          ]);

          let serviceResults: Awaited<ReturnType<typeof signUpTx.execute>>;
          try {
            serviceResults = await signUpTx.execute();
          } catch (cause) {
            if (isUniqueConstraintError(cause)) {
              if (cause.columns?.includes("email")) {
                return error(
                  { message: "Email already exists", code: "email_already_exists" },
                  400,
                );
              }

              if (cause.constraint === "idx_organization_slug" || cause.columns?.includes("slug")) {
                return error(
                  { message: "Organization slug taken", code: "organization_slug_taken" },
                  400,
                );
              }
            }
            throw cause;
          }

          const [result] = serviceResults;

          if (!result.ok) {
            if (result.code === "organization_slug_taken") {
              return error(
                { message: "Organization slug taken", code: "organization_slug_taken" },
                400,
              );
            }

            return error({ message: "Email already exists", code: "email_already_exists" }, 400);
          }

          if (result.status === "email_verification_required") {
            return Response.json({
              status: result.status,
              userId: result.user.id,
              email: result.user.email,
              role: result.user.role,
            });
          }

          const issuedCredential = await issueSessionBackedAuthCredential({
            accessTokens,
            session: result.credential,
          });
          const issuedAuth = buildIssuedAuthResponse(issuedCredential, config.cookieOptions, {
            issueCookie: accessTokens?.issueCookie,
          });

          return Response.json(
            {
              status: result.status,
              auth: issuedAuth.auth,
              userId: result.credential.user.id,
              email: result.credential.user.email,
              role: result.credential.user.role,
            },
            { headers: issuedAuth.headers },
          );
        },
      }),

      defineRoute({
        method: "POST",
        path: "/sign-in",
        inputSchema: z.object({
          email: authEmailSchema,
          password: z.string().min(8).max(100),
          auth: credentialSeedSchema.optional(),
        }),
        outputSchema: z.object({
          auth: issuedAuthSchema,
          userId: z.string(),
          email: z.string(),
          role: z.enum(["user", "admin"]),
        }),
        errorCodes: [
          "invalid_credentials",
          "user_banned",
          "email_verification_required",
          "email_password_disabled",
        ],
        handler: async function ({ input }, { error }) {
          if (!emailAndPasswordEnabled) {
            return error(
              { message: "Email/password auth is disabled", code: "email_password_disabled" },
              403,
            );
          }

          const { email, password, auth } = await input.valid();
          let passwordCheck: { ok: true } | { ok: false; code: "invalid_credentials" } | null =
            null;

          const result = await this.handlerTx({
            onAfterRetrieve: async (_uow, results) => {
              const firstResult = Array.isArray(results[0]) ? results[0] : [];
              const user = (firstResult[0] ?? null) as {
                passwordHash?: string | null;
              } | null;

              if (!user?.passwordHash) {
                passwordCheck = { ok: false, code: "invalid_credentials" };
                return;
              }

              const isValid = await verifyPassword(password, user.passwordHash);
              if (!isValid) {
                passwordCheck = { ok: false, code: "invalid_credentials" };
                return;
              }

              passwordCheck = { ok: true };
            },
          })
            .retrieve(({ forSchema }) =>
              forSchema(authSchema)
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
            .mutate(({ forSchema, retrieveResult: [users, requestEligibleUser] }) => {
              const user = users[0] ?? null;
              if (!user || !passwordCheck) {
                return { ok: false as const, code: "invalid_credentials" as const };
              }

              if (!passwordCheck.ok) {
                return { ok: false as const, code: passwordCheck.code };
              }

              const userSummary = mapUserSummary({
                id: user.id.valueOf(),
                email: user.email,
                role: user.role,
                bannedAt: user.bannedAt ?? null,
              });
              const eligibility = evaluateCredentialEligibility(
                {
                  ...userSummary,
                  emailVerifiedAt: user.emailVerifiedAt ?? null,
                },
                config.emailVerification,
              );
              const uow = forSchema(authSchema);
              if (!eligibility.ok) {
                if (eligibility.code === "email_verification_required") {
                  const emailVerificationRequest = planEmailVerificationRequest(
                    {
                      ...userSummary,
                      bannedAt: user.bannedAt ?? null,
                      emailVerifiedAt: user.emailVerifiedAt ?? null,
                    },
                    config.emailVerification,
                    {
                      requestCooldownElapsed:
                        requestEligibleUser?.id.valueOf() === user.id.valueOf(),
                    },
                  );
                  recordEmailVerificationRequest(uow, {
                    plan: emailVerificationRequest,
                    target: { kind: "persisted", userId: user.id },
                    user: userSummary,
                    reason: "sign_in",
                  });
                }
                return eligibility;
              }

              // TODO: Use services.issueCredential instead of inline credential issuance (sign-up and
              // handleOAuthCallback also duplicate this logic)
              const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
              const credentialSeedMembers = collectCredentialSeedMembers(users);
              const resolvedCredentialSeed = resolveCredentialSeedFromMembers(
                credentialSeedMembers,
                auth,
              );
              const activeOrganizationId = resolvedCredentialSeed.activeOrganizationId;
              const databaseSessionExpiresAt = uow.now().plus({ days: 30 });
              const credentialId = uow.create("session", {
                userId: user.id,
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
                organizationIds: collectOrganizationIdsFromSeedMembers(credentialSeedMembers),
                user: {
                  id: userSummary.id,
                  email: userSummary.email,
                  role: userSummary.role,
                },
              };

              return {
                ok: true as const,
                credential,
              };
            })
            .execute();

          if (!result.ok) {
            if (result.code === "user_banned") {
              return error({ message: "User is banned", code: "user_banned" }, 403);
            }
            if (result.code === "email_verification_required") {
              return error(
                {
                  message: "Verify your email before signing in.",
                  code: "email_verification_required",
                },
                403,
              );
            }
            return error({ message: "Invalid credentials", code: "invalid_credentials" }, 401);
          }

          const issuedCredential = await issueSessionBackedAuthCredential({
            accessTokens,
            session: result.credential,
          });
          const issuedAuth = buildIssuedAuthResponse(issuedCredential, config.cookieOptions, {
            issueCookie: accessTokens?.issueCookie,
          });

          return Response.json(
            {
              auth: issuedAuth.auth,
              userId: result.credential.user.id,
              email: result.credential.user.email,
              role: result.credential.user.role,
            },
            { headers: issuedAuth.headers },
          );
        },
      }),

      defineRoute({
        method: "POST",
        path: "/change-password",
        inputSchema: z.object({
          newPassword: z.string().min(8).max(100),
        }),
        outputSchema: z.object({
          success: z.boolean(),
        }),
        errorCodes: ["credential_invalid"],
        handler: async function ({ input, headers }, { json, error }) {
          const { newPassword } = await input.valid();

          const credential = await resolveBackingSessionCredential({
            headers,
            cookieOptions: config.cookieOptions,
            accessTokens,
          });
          if (!credential.ok) {
            return error(
              {
                message:
                  credential.reason === "malformed"
                    ? "Malformed authentication"
                    : "Authentication required",
                code: "credential_invalid",
              },
              credential.reason === "invalid" ? 401 : 400,
            );
          }

          const passwordHash = await hashPassword(newPassword);

          const credentialToken = credential.credential.token;

          const [result] = await this.handlerTx()
            .withServiceCalls(() => [
              services.changePasswordForCredential(credentialToken, passwordHash),
            ])
            .execute();

          if (!result.ok) {
            return error({ message: "Invalid credential", code: "credential_invalid" }, 401);
          }

          return json({ success: true });
        },
      }),
    ];
  },
);

export type UserActionsRoutesFactory = typeof userActionsRoutesFactory;
