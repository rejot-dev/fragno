import type { Role } from "./types";

export const DEFAULT_EMAIL_VERIFICATION_REQUEST_COOLDOWN_SECONDS = 60;

export type AuthEmailVerificationPolicyUser = {
  id: string;
  email: string;
  role: Role;
};

export type AuthEmailVerificationConfig = {
  requestCooldownSeconds?: number;
  isExempt?: (input: { user: AuthEmailVerificationPolicyUser }) => boolean;
};

type CredentialEligibilityUser = AuthEmailVerificationPolicyUser & {
  bannedAt: Date | null;
  emailVerifiedAt: Date | null;
};

export type EmailVerificationRequestUser = CredentialEligibilityUser;

export type CredentialEligibilityResult =
  | { ok: true }
  | { ok: false; code: "user_banned" | "email_verification_required" };

export type EmailVerificationRequestSuppressionReason =
  | "disabled"
  | "banned"
  | "verified"
  | "exempt"
  | "cooldown";

export type EmailVerificationRequestPlan =
  | { status: "requested" }
  | {
      status: "suppressed";
      reason: EmailVerificationRequestSuppressionReason;
    };

export type RequestUserEmailVerificationResult =
  | { status: "requested" }
  | { status: "suppressed"; reason: EmailVerificationRequestSuppressionReason | "not_found" };

export type VerifyUserEmailInput = {
  userId: string;
  expectedEmail: string;
  verifiedAt: Date;
};

export type VerifyUserEmailResult =
  | {
      ok: true;
      status: "verified";
      emailVerifiedAt: Date;
    }
  | {
      ok: true;
      status: "already_verified";
      emailVerifiedAt: Date;
    }
  | {
      ok: false;
      code: "user_not_found" | "email_changed";
    };

const toPolicyUser = (user: AuthEmailVerificationPolicyUser) => ({
  id: user.id,
  email: user.email,
  role: user.role,
});

export const validateEmailVerificationConfig = (
  emailVerification: AuthEmailVerificationConfig | undefined,
): void => {
  if (!emailVerification) {
    return;
  }

  const cooldownSeconds =
    emailVerification.requestCooldownSeconds ?? DEFAULT_EMAIL_VERIFICATION_REQUEST_COOLDOWN_SECONDS;
  if (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 0) {
    throw new Error("emailVerification.requestCooldownSeconds must be a non-negative integer.");
  }
};

export const evaluateCredentialEligibility = (
  user: CredentialEligibilityUser,
  emailVerification: AuthEmailVerificationConfig | undefined,
): CredentialEligibilityResult => {
  if (user.bannedAt) {
    return { ok: false, code: "user_banned" };
  }

  if (!emailVerification) {
    return { ok: true };
  }

  if (emailVerification.isExempt?.({ user: toPolicyUser(user) })) {
    return { ok: true };
  }

  return user.emailVerifiedAt ? { ok: true } : { ok: false, code: "email_verification_required" };
};

export const planEmailVerificationRequest = (
  user: EmailVerificationRequestUser,
  emailVerification: AuthEmailVerificationConfig | undefined,
  timing: { requestCooldownElapsed: boolean },
): EmailVerificationRequestPlan => {
  if (!emailVerification) {
    return { status: "suppressed", reason: "disabled" };
  }

  if (user.bannedAt) {
    return { status: "suppressed", reason: "banned" };
  }

  if (user.emailVerifiedAt) {
    return { status: "suppressed", reason: "verified" };
  }

  if (emailVerification.isExempt?.({ user: toPolicyUser(user) })) {
    return { status: "suppressed", reason: "exempt" };
  }

  if (!timing.requestCooldownElapsed) {
    return { status: "suppressed", reason: "cooldown" };
  }

  return { status: "requested" };
};
