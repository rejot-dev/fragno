import type { BetterAuthOptions, BetterAuthPlugin, ValidateUserInfoResult } from "better-auth";
import { APIError, createAuthMiddleware, getOAuthState } from "better-auth/api";
import { z } from "zod";

import type { AccessCodeCheck, AccessCodeRejection } from "@/fragno/access-codes/contracts";

type ValidateUserInfo = NonNullable<NonNullable<BetterAuthOptions["user"]>["validateUserInfo"]>;

/**
 * The ways people create their own accounts. A first-party app's email-code sign-in and an
 * administrator's provisioning create accounts for people the app or administrator vouches for.
 */
const SELF_SIGN_UP_METHODS: ReadonlySet<string> = new Set(["email-password", "oauth"]);

// Password sign-up sends the code in its body; OAuth sign-in carries it through the provider in
// the state's `additionalData`. Both are client-supplied, which a secret code may be.

const ACCESS_CODE_REJECTIONS = {
  invalid: {
    error: "access_code_invalid",
    errorDescription: "This access code is not valid.",
  },
  expired: {
    error: "access_code_expired",
    errorDescription: "This access code has expired.",
  },
} as const satisfies Record<AccessCodeRejection, ValidateUserInfoResult>;

const ACCESS_CODE_REQUIRED = {
  error: "access_code_required",
  errorDescription: "An access code is required to create a Backoffice account.",
} as const satisfies ValidateUserInfoResult;

/** Why `carrier` does not admit an account, or null when `use` accepts its code. */
async function rejectAccessCode(
  carrier: unknown,
  use: (code: string) => Promise<AccessCodeCheck>,
): Promise<ValidateUserInfoResult | null> {
  const parsed = z.object({ accessCode: z.string().trim().min(1) }).safeParse(carrier);
  if (!parsed.success) {
    return ACCESS_CODE_REQUIRED;
  }
  const check = await use(parsed.data.accessCode);
  return check.ok ? null : ACCESS_CODE_REJECTIONS[check.reason];
}

/**
 * Admits a new account only with an access code, and records which code admitted it. Better Auth
 * calls this just before it creates any user, so no sign-up method can skip it. A sign-up that
 * fails after this still counts as a redemption.
 */
export function createAccessCodeGate(input: {
  redeemAccessCode: (redemption: { code: string; email: string }) => Promise<AccessCodeCheck>;
}): ValidateUserInfo {
  return async function requireAccessCode({ user, source }, context) {
    if (source.action !== "create-user" || !SELF_SIGN_UP_METHODS.has(source.method)) {
      return undefined;
    }
    // Better Auth creates every user with an address, already normalized.
    const email = z.string().min(1).parse(user.email);
    const rejection = await rejectAccessCode(
      source.method === "oauth" ? await getOAuthState() : context.body,
      async (code) => await input.redeemAccessCode({ code, email }),
    );
    return rejection ?? undefined;
  };
}

/**
 * While email verification is required, password sign-up answers every rejected account creation
 * as if it succeeded, so that it never reveals which addresses have accounts. Checking the code
 * first lets a rejected code say why; a code revoked between the check and the gate gets that
 * generic answer. Revealing a code's state reveals nothing about any address.
 */
export function createPasswordSignUpAccessCodeCheck(input: {
  checkAccessCode: (code: string) => Promise<AccessCodeCheck>;
}): BetterAuthPlugin {
  return {
    id: "fragno-backoffice-password-sign-up-access-code",
    hooks: {
      before: [
        {
          matcher(context) {
            return context.path === "/sign-up/email";
          },
          handler: createAuthMiddleware(async function rejectUnusableAccessCode(context) {
            const rejection = await rejectAccessCode(context.body, input.checkAccessCode);
            if (rejection !== null) {
              throw APIError.from("FORBIDDEN", {
                code: rejection.error,
                message: rejection.errorDescription ?? rejection.error,
              });
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
