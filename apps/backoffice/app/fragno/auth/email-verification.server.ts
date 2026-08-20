import type { RouterContextProvider } from "react-router";

import { callBetterAuth } from "./auth-server";

export type EmailVerificationResendResult =
  | { status: "accepted"; email: string }
  | { status: "error"; message: string };

export const requestEmailVerificationResend = async (input: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  email: string;
}): Promise<EmailVerificationResendResult> => {
  const email = input.email.trim().toLowerCase();
  const response = await callBetterAuth(input.request, input.context, "/send-verification-email", {
    method: "POST",
    body: JSON.stringify({ email, callbackURL: "/backoffice/login" }),
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as { message?: string } | null;
    return { status: "error", message: error?.message || "Unable to request verification." };
  }
  return { status: "accepted", email };
};
