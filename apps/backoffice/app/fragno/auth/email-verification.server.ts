import type { RouterContextProvider } from "react-router";

import { createAuthRouteCaller } from "./auth-server";

export type EmailVerificationResendResult =
  | {
      status: "accepted";
      email: string;
    }
  | {
      status: "failed";
      message: string;
    };

export const requestEmailVerificationResend = async (input: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  email: string;
}): Promise<EmailVerificationResendResult> => {
  const response = await createAuthRouteCaller(input.request, input.context)(
    "POST",
    "/email-verification/resend",
    { body: { email: input.email } },
  );

  return response.type === "error"
    ? { status: "failed", message: "We could not request another verification email." }
    : { status: "accepted", email: input.email };
};
