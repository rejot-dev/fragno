import type { Role } from "./types";

export type AuthEmailVerificationPolicyUser = {
  id: string;
  email: string;
  role: Role;
};

export type AuthEmailVerificationConfig = {
  required: boolean;
  isExempt?: (input: { user: AuthEmailVerificationPolicyUser }) => boolean;
};

type CredentialEligibilityUser = AuthEmailVerificationPolicyUser & {
  bannedAt: Date | null;
  emailVerifiedAt: Date | null;
};

export type CredentialEligibilityResult =
  | { ok: true }
  | { ok: false; code: "user_banned" | "email_verification_required" };

export const evaluateCredentialEligibility = (
  user: CredentialEligibilityUser,
  emailVerification: AuthEmailVerificationConfig | undefined,
): CredentialEligibilityResult => {
  if (user.bannedAt) {
    return { ok: false, code: "user_banned" };
  }

  if (!emailVerification?.required) {
    return { ok: true };
  }

  const policyUser = {
    id: user.id,
    email: user.email,
    role: user.role,
  } satisfies AuthEmailVerificationPolicyUser;

  if (emailVerification.isExempt?.({ user: policyUser })) {
    return { ok: true };
  }

  return user.emailVerifiedAt ? { ok: true } : { ok: false, code: "email_verification_required" };
};
