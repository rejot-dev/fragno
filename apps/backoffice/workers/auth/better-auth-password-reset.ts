import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { z } from "zod";

const resetRequestSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(191)),
});

/**
 * Recovery also adds a password to accounts that have none. That grants nothing new: inbox control
 * already signs in through trusted GitHub account linking.
 */
export function createBackofficePasswordResetPlugin(input: {
  publicBaseUrl: string | null;
  acceptRequest: (email: string) => boolean;
}): BetterAuthPlugin {
  return {
    id: "fragno-backoffice-password-reset",
    hooks: {
      before: [
        {
          matcher(context) {
            return context.path === "/request-password-reset";
          },
          handler: createAuthMiddleware(async function prepareRecoveryRequest(context) {
            if (input.publicBaseUrl === null) {
              throw APIError.from("SERVICE_UNAVAILABLE", {
                code: "PASSWORD_RESET_UNAVAILABLE",
                message: "Password reset is not configured.",
              });
            }
            const parsed = resetRequestSchema.safeParse(context.body);
            if (!parsed.success) {
              throw APIError.from("BAD_REQUEST", {
                code: "INVALID_EMAIL",
                message: "Enter a valid email address.",
              });
            }
            const { email } = parsed.data;
            const accepted = {
              status: true,
              message: "If this email exists in our system, check your email for the reset link",
            };
            // Suppress email floods without disclosing whether the address has an account.
            if (!input.acceptRequest(email)) {
              return context.json(accepted);
            }
            context.body.email = email;
            context.body.redirectTo = new URL(
              "/backoffice/reset-password",
              input.publicBaseUrl,
            ).href;
            return undefined;
          }),
        },
      ],
    },
  };
}
