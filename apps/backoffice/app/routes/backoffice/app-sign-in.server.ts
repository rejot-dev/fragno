import type { AppBranding } from "@fragno-dev/backoffice-api/v0/apps";
import { redirect, type RouterContextProvider } from "react-router";
import { z } from "zod";

import { callBetterAuth, createBackofficeIdentityChangeHeaders } from "@/fragno/auth/auth-server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

/** The login page in a first-party app's name, for a request that app sent here. */
export type AppSignInPage = { kind: "app"; branding: AppBranding; loginHint: string | null };

/**
 * Where sign-in stands after a submission. On the code step, `sent` and `resent` mean a new code
 * went out, which restarts the wait before another; a rejected attempt sends nothing.
 */
export type AppSignInActionData =
  | { step: "email"; email: string; error: string }
  | {
      step: "code";
      email: string;
      outcome: { kind: "sent" } | { kind: "resent" } | { kind: "rejected"; error: string };
    };

/**
 * The first-party app a signed authorization request names, if it has branding. The page reads the
 * client without checking the signature, which only decides how the page looks: Better Auth checks
 * it on every code request and sign-in the page makes.
 */
export async function findAppSignInPage(
  context: Readonly<RouterContextProvider>,
  oauthQuery: string,
): Promise<AppSignInPage | null> {
  const query = new URLSearchParams(oauthQuery);
  const clientId = query.get("client_id");
  if (clientId === null) {
    return null;
  }
  const app = await context
    .get(BackofficeWorkerContext)
    .runtime.objects.apps.singleton()
    .commands.getAppByOAuthClientId({ oauthClientId: clientId });
  return app?.trust.kind === "first-party"
    ? { kind: "app", branding: app.trust.branding, loginHint: query.get("login_hint") }
    : null;
}

const appSignInActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.enum(["send_code", "resend_code"]),
    email: z.string().trim().toLowerCase().pipe(z.email().max(191)),
  }),
  z.object({
    intent: z.literal("verify_code"),
    email: z.string().trim().toLowerCase().pipe(z.email().max(191)),
    code: z.string().trim(),
  }),
]);

const betterAuthErrorSchema = z.object({
  code: z.string().nullish(),
  error: z.string().nullish(),
});

async function readBetterAuthErrorCode(response: Response, path: string): Promise<string | null> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new Error(`Better Auth ${path} answered HTTP ${response.status} without a JSON error.`, {
      cause,
    });
  }
  const parsed = betterAuthErrorSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `Better Auth ${path} answered HTTP ${response.status} with an unexpected error shape.`,
      { cause: parsed.error },
    );
  }
  return parsed.data.code ?? parsed.data.error ?? null;
}

/**
 * Plain-language explanations of the failures people cause; the people apps send here may not be
 * technical. Any other failure is Backoffice's, so it propagates to the route's error handling.
 */
async function explainFailure(
  response: Response,
  path: string,
  branding: AppBranding,
): Promise<string> {
  if (response.status === 429) {
    return "Please wait a minute before trying again.";
  }
  const code = await readBetterAuthErrorCode(response, path);
  switch (code) {
    case "INVALID_OTP":
      return "That code isn't right. Check the email and try again.";
    case "OTP_EXPIRED":
    case "TOO_MANY_ATTEMPTS":
      return "That code no longer works. Send a new one and try again.";
    case "invalid_signature":
      return `This sign-in page has expired. Go back to ${branding.displayName} and try again.`;
    case null:
    default:
      throw new Error(
        `Better Auth ${path} failed with HTTP ${response.status} (${code ?? "no error code"}).`,
      );
  }
}

/** Sends a sign-in code, or signs in with one and continues to the app. */
export async function appSignInAction(input: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  page: AppSignInPage;
  oauthQuery: string;
  formData: FormData;
}): Promise<AppSignInActionData | Response> {
  const parsed = appSignInActionSchema.safeParse(Object.fromEntries(input.formData));
  if (!parsed.success) {
    const email = String(input.formData.get("email") ?? "");
    return input.formData.get("intent") === "verify_code"
      ? {
          step: "code",
          email,
          outcome: { kind: "rejected", error: "Enter the 6-digit code from the email." },
        }
      : { step: "email", email, error: "Enter a valid email address." };
  }
  const { email } = parsed.data;

  if (parsed.data.intent !== "verify_code") {
    const path = "/email-otp/send-verification-otp";
    const sent = await callBetterAuth(input.request, input.context, path, {
      method: "POST",
      body: JSON.stringify({ email, type: "sign-in", oauth_query: input.oauthQuery }),
    });
    if (!sent.ok) {
      const error = await explainFailure(sent, path, input.page.branding);
      return parsed.data.intent === "send_code"
        ? { step: "email", email, error }
        : { step: "code", email, outcome: { kind: "rejected", error } };
    }
    return {
      step: "code",
      email,
      outcome: { kind: parsed.data.intent === "send_code" ? "sent" : "resent" },
    };
  }

  const path = "/sign-in/email-otp";
  const signedIn = await callBetterAuth(input.request, input.context, path, {
    method: "POST",
    body: JSON.stringify({
      email,
      otp: parsed.data.code.replaceAll(/\s/gu, ""),
      // New users have no name yet; the address's local part stands in, as on Backoffice's sign-up.
      name: email.split("@", 1)[0] || email,
      oauth_query: input.oauthQuery,
    }),
  });
  if (!signedIn.ok) {
    return {
      step: "code",
      email,
      outcome: {
        kind: "rejected",
        error: await explainFailure(signedIn, path, input.page.branding),
      },
    };
  }
  // The OAuth Provider continues the app's authorization once the session exists.
  const continued = z.object({ url: z.string().min(1) }).parse(await signedIn.json());
  return redirect(continued.url, { headers: createBackofficeIdentityChangeHeaders(signedIn) });
}
