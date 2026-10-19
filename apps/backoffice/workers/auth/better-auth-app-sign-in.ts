import { defineRequestState } from "@better-auth/core/context";
import type { AppBranding } from "@fragno-dev/backoffice-api/v0/apps";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emailOTP } from "better-auth/plugins/email-otp";

import { getOAuthProviderState } from "@better-auth/oauth-provider";

const APP_SIGN_IN_CODE_LIFETIME_SECONDS = 10 * 60;

/** Email-code endpoints Backoffice does not use; its own sign-in keeps passwords and links. */
export const UNUSED_EMAIL_CODE_PATHS = [
  "/email-otp/check-verification-otp",
  "/email-otp/verify-email",
  "/email-otp/request-password-reset",
  "/forget-password/email-otp",
  "/email-otp/reset-password",
  "/email-otp/request-email-change",
  "/email-otp/change-email",
];

/** The first-party app a code sign-in came through, as verified for this request. */
const appSignInRequest = defineRequestState<AppBranding | null>(() => null);

/**
 * Signing in with a code sent to an email, available only while a first-party app sends someone to
 * Backoffice. A correct code proves the address, so it signs in its user or creates one already
 * verified, and anyone may sign up this way. Outside an app's request, Backoffice's sign-in and
 * invitation-only sign-up stay as they are.
 *
 * The OAuth Provider verifies the request's signed `oauth_query` before this plugin's hook runs, so
 * the plugin must come after it.
 */
export function createBackofficeAppSignInPlugins(input: {
  findFirstPartyBranding(clientId: string): Promise<AppBranding | null>;
  sendSignInCode(input: {
    email: string;
    code: string;
    expiresInMinutes: number;
    branding: AppBranding;
  }): Promise<void>;
}): BetterAuthPlugin[] {
  return [
    emailOTP({
      otpLength: 6,
      expiresIn: APP_SIGN_IN_CODE_LIFETIME_SECONDS,
      allowedAttempts: 5,
      storeOTP: "hashed",
      sendVerificationOTP: async function sendAppSignInCode({ email, otp }) {
        const branding = await appSignInRequest.get();
        if (branding === null) {
          throw new Error("A sign-in code was requested outside a first-party app's sign-in.");
        }
        await input.sendSignInCode({
          email,
          code: otp,
          expiresInMinutes: APP_SIGN_IN_CODE_LIFETIME_SECONDS / 60,
          branding,
        });
      },
    }),
    {
      id: "fragno-backoffice-app-sign-in",
      hooks: {
        before: [
          {
            matcher(context) {
              return (
                context.path === "/email-otp/send-verification-otp" ||
                context.path === "/sign-in/email-otp"
              );
            },
            handler: createAuthMiddleware(async function requireFirstPartyApp(context) {
              if (
                context.path === "/email-otp/send-verification-otp" &&
                context.body?.type !== "sign-in"
              ) {
                throw new APIError("BAD_REQUEST", { message: "Only sign-in codes are sent." });
              }
              const oauthRequest = await getOAuthProviderState();
              const clientId = oauthRequest?.query
                ? new URLSearchParams(oauthRequest.query).get("client_id")
                : null;
              const branding = clientId ? await input.findFirstPartyBranding(clientId) : null;
              if (branding === null) {
                throw new APIError("FORBIDDEN", {
                  message: "Signing in with a code is available only through an app.",
                });
              }
              await appSignInRequest.set(branding);
            }),
          },
        ],
      },
    },
  ];
}
