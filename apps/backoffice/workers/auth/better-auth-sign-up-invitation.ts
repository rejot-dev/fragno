import { type BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { z } from "zod";

import type { ConfirmSignUpInvitationResult } from "../otp.do";

const signUpInvitationRequestSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  invitationId: z.string().trim().min(1),
  invitationCode: z.string().trim().min(1),
});

const SIGN_UP_INVITATION_ERROR = {
  message: "A valid sign-up invitation is required.",
  code: "SIGN_UP_INVITATION_REQUIRED",
} as const;

/** Requires an email-bound sign-up invitation on every Better Auth password registration. */
export function createBackofficeSignUpInvitationPlugin(input: {
  confirmSignUpInvitation: (input: {
    invitationId: string;
    code: string;
    email: string;
  }) => Promise<ConfirmSignUpInvitationResult>;
}): BetterAuthPlugin {
  return {
    id: "fragno-backoffice-sign-up-invitation",
    hooks: {
      before: [
        {
          matcher(context) {
            return context.path === "/sign-up/email";
          },
          handler: createAuthMiddleware(async function requireSignUpInvitation(context) {
            const invitationRequest = signUpInvitationRequestSchema.safeParse(context.body);
            if (!invitationRequest.success) {
              throw APIError.from("FORBIDDEN", SIGN_UP_INVITATION_ERROR);
            }

            const confirmation = await input.confirmSignUpInvitation({
              invitationId: invitationRequest.data.invitationId,
              code: invitationRequest.data.invitationCode,
              email: invitationRequest.data.email,
            });
            if (!confirmation.ok) {
              throw APIError.from("FORBIDDEN", SIGN_UP_INVITATION_ERROR);
            }

            context.body.email = confirmation.email;
            delete context.body.invitationId;
            delete context.body.invitationCode;
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
