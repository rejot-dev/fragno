import type { FragnoId } from "@fragno-dev/db/schema";

import {
  evaluateCredentialEligibility,
  type AuthEmailVerificationConfig,
} from "../email-verification-policy";
import type { UserSummary } from "../types";
import { mapUserSummary } from "../user/summary";

export const sessionCredentialOwnerSelect = [
  "id",
  "email",
  "role",
  "bannedAt",
  "emailVerifiedAt",
] as const;

type SessionCredentialOwner = {
  id: FragnoId;
  email: string;
  role: string;
  bannedAt: Date | null;
  emailVerifiedAt: Date | null;
};

export type SessionCredentialOwnerValidationResult<TOwner extends SessionCredentialOwner> =
  | { ok: true; owner: TOwner; user: UserSummary }
  | { ok: false; code: "credential_invalid" };

export function validateSessionCredentialOwner<TOwner extends SessionCredentialOwner>(
  owner: TOwner | null | undefined,
  emailVerification: AuthEmailVerificationConfig | undefined,
): SessionCredentialOwnerValidationResult<TOwner> {
  if (!owner) {
    return { ok: false, code: "credential_invalid" };
  }

  const user = mapUserSummary(owner);
  const eligibility = evaluateCredentialEligibility(
    {
      ...user,
      emailVerifiedAt: owner.emailVerifiedAt,
    },
    emailVerification,
  );
  if (!eligibility.ok) {
    // Existing credentials intentionally hide the account-policy reason from callers.
    return { ok: false, code: "credential_invalid" };
  }

  return { ok: true, owner, user };
}
