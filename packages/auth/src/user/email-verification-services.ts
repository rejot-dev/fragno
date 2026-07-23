import type { FragnoId } from "@fragno-dev/db/schema";

import type { DatabaseServiceContext, TypedUnitOfWork } from "@fragno-dev/db";

import {
  DEFAULT_EMAIL_VERIFICATION_REQUEST_COOLDOWN_SECONDS,
  planEmailVerificationRequest,
  type AuthEmailVerificationConfig,
  type EmailVerificationRequestPlan,
  type RequestUserEmailVerificationResult,
  type VerifyUserEmailInput,
  type VerifyUserEmailResult,
} from "../email-verification";
import type { AuthHooksMap, UserEmailVerificationRequestReason } from "../hooks";
import { authSchema } from "../schema";
import type { UserSummary } from "../types";
import { normalizeAuthEmail } from "./email";
import { mapUserSummary } from "./summary";

type AuthServiceContext = DatabaseServiceContext<AuthHooksMap>;
type AuthUow = TypedUnitOfWork<typeof authSchema, unknown[], unknown, AuthHooksMap>;

type EmailVerificationRequestTarget =
  | { kind: "new" }
  | {
      kind: "persisted";
      userId: FragnoId;
    };

export const recordEmailVerificationRequest = (
  uow: AuthUow,
  input: {
    plan: EmailVerificationRequestPlan;
    target: EmailVerificationRequestTarget;
    user: UserSummary;
    reason: UserEmailVerificationRequestReason;
  },
): RequestUserEmailVerificationResult => {
  if (input.plan.status === "suppressed") {
    return input.plan;
  }

  if (input.target.kind === "persisted") {
    uow.update("user", input.target.userId, (builder) =>
      builder.set({ emailVerificationRequestedAt: builder.now() }).check(),
    );
  }

  uow.triggerHook("onUserEmailVerificationRequested", {
    user: input.user,
    reason: input.reason,
  });

  return { status: "requested" };
};

export const createEmailVerificationServices = (
  emailVerification: AuthEmailVerificationConfig | undefined,
) => ({
  requestUserEmailVerification: function (
    this: AuthServiceContext,
    email: string,
    reason: UserEmailVerificationRequestReason,
  ) {
    const normalizedEmail = normalizeAuthEmail(email);
    const cooldownSeconds =
      emailVerification?.requestCooldownSeconds ??
      DEFAULT_EMAIL_VERIFICATION_REQUEST_COOLDOWN_SECONDS;

    return this.serviceTx(authSchema)
      .retrieve((uow) =>
        uow
          .findFirst("user", (b) =>
            b
              .whereIndex("idx_user_email", (eq) => eq("email", "=", normalizedEmail))
              .select(["id", "email", "role", "bannedAt", "emailVerifiedAt"]),
          )
          .findFirst("user", (b) =>
            b
              .whereIndex("idx_user_email_verification_request", (eq) =>
                eq.and(
                  eq("email", "=", normalizedEmail),
                  eq.or(
                    eq.isNull("emailVerificationRequestedAt"),
                    eq(
                      "emailVerificationRequestedAt",
                      "<=",
                      eq.now().plus({ seconds: -cooldownSeconds }),
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
          retrieveResult: [user, requestEligibleUser],
        }): RequestUserEmailVerificationResult => {
          if (!user) {
            return { status: "suppressed", reason: "not_found" };
          }

          const userSummary = mapUserSummary(user);
          const plan = planEmailVerificationRequest(
            {
              ...userSummary,
              bannedAt: user.bannedAt ?? null,
              emailVerifiedAt: user.emailVerifiedAt ?? null,
            },
            emailVerification,
            {
              requestCooldownElapsed: requestEligibleUser?.id.valueOf() === user.id.valueOf(),
            },
          );

          return recordEmailVerificationRequest(uow, {
            plan,
            target: { kind: "persisted", userId: user.id },
            user: userSummary,
            reason,
          });
        },
      )
      .build();
  },

  verifyUserEmail: function (this: AuthServiceContext, input: VerifyUserEmailInput) {
    return this.serviceTx(authSchema)
      .retrieve((uow) =>
        uow.findFirst("user", (builder) =>
          builder
            .whereIndex("primary", (expression) => expression("id", "=", input.userId))
            .select(["id", "email", "role", "bannedAt", "emailVerifiedAt"]),
        ),
      )
      .mutate(({ uow, retrieveResult: [user] }): VerifyUserEmailResult => {
        if (!user) {
          return { ok: false, code: "user_not_found" };
        }

        if (user.email !== normalizeAuthEmail(input.expectedEmail)) {
          return { ok: false, code: "email_changed" };
        }

        if (user.emailVerifiedAt) {
          return {
            ok: true,
            status: "already_verified",
            emailVerifiedAt: user.emailVerifiedAt,
          };
        }

        uow.update("user", user.id, (builder) =>
          builder
            .set({
              emailVerifiedAt: input.verifiedAt,
              emailVerificationRequestedAt: null,
            })
            .check(),
        );
        uow.triggerHook("onUserEmailVerified", {
          user: mapUserSummary(user),
          actor: null,
          emailVerifiedAt: input.verifiedAt.toISOString(),
        });

        return {
          ok: true,
          status: "verified",
          emailVerifiedAt: input.verifiedAt,
        };
      })
      .build();
  },
});
