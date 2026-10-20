import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { z } from "zod";

const resetRequestSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(191)),
});

/** Recovery is for existing password accounts, not a way to add a password to a social account. */
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
          handler: createAuthMiddleware(async function requirePasswordRecoveryAccount(context) {
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
            const user = await context.context.internalAdapter.findUserByEmail(email);
            if (
              user &&
              !(await context.context.internalAdapter.findCredentialAccount(user.user.id))
            ) {
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
