import type { RouterContextProvider } from "react-router";
import { createCookie } from "react-router";
import { z } from "zod";

import { resolveRefreshCookieName } from "@fragno-dev/auth";

import { resolveLiveAccessTokenSecret } from "@/fragno/auth/auth";
import { getAuthDurableObject } from "@/worker-runtime/durable-objects";
import { getSetCookieHeaders } from "@/worker-runtime/http-headers";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

const EMAIL_VERIFICATION_LOGIN_GRANT_COOKIE = "fragno_email_verification_login";
const EMAIL_VERIFICATION_LOGIN_GRANT_TTL_SECONDS = 5 * 60;

const emailVerificationLoginGrantSchema = z.object({
  userId: z.string().min(1),
  expiresAt: z.number().int().positive(),
});

type EmailVerificationLoginGrant = z.infer<typeof emailVerificationLoginGrantSchema>;

export type CompleteEmailVerificationLoginResult =
  | { status: "pending"; headers: Array<[string, string]> }
  | { status: "authenticated"; headers: Array<[string, string]> }
  | { status: "unavailable"; headers: Array<[string, string]> };

const createEmailVerificationLoginGrantCookie = (context: Readonly<RouterContextProvider>) => {
  const { env } = context.get(BackofficeWorkerContext);
  const isDevelopment = import.meta.env.MODE === "development";

  return createCookie(EMAIL_VERIFICATION_LOGIN_GRANT_COOKIE, {
    httpOnly: true,
    maxAge: EMAIL_VERIFICATION_LOGIN_GRANT_TTL_SECONDS,
    // React Router fetchers submit to `/backoffice/verify-email.data`; scope the cookie to the
    // Backoffice rather than the document URL so completion requests receive the grant.
    path: "/backoffice",
    sameSite: "lax",
    secrets: [resolveLiveAccessTokenSecret(env, isDevelopment)],
    secure: !isDevelopment,
  });
};

const clearEmailVerificationLoginGrant = async (
  context: Readonly<RouterContextProvider>,
): Promise<Array<[string, string]>> => [
  [
    "Set-Cookie",
    await createEmailVerificationLoginGrantCookie(context).serialize("", { maxAge: 0 }),
  ],
];

const readEmailVerificationLoginGrant = async (
  request: Request,
  context: Readonly<RouterContextProvider>,
): Promise<EmailVerificationLoginGrant | null> => {
  const value = await createEmailVerificationLoginGrantCookie(context).parse(
    request.headers.get("Cookie"),
  );
  const parsed = emailVerificationLoginGrantSchema.safeParse(value);
  if (!parsed.success || parsed.data.expiresAt <= Date.now()) {
    return null;
  }
  return parsed.data;
};

const RETRYABLE_REFRESH_STATUSES = new Set([408, 425, 429, 502, 503, 504]);
const TERMINAL_REFRESH_ERROR_CODES = new Set(["credential_invalid", "access_tokens_disabled"]);

const readAuthErrorCode = async (response: Response): Promise<string | null> => {
  try {
    const body: unknown = await response.clone().json();
    if (!body || typeof body !== "object" || !("code" in body)) {
      return null;
    }
    return typeof body.code === "string" ? body.code : null;
  } catch {
    return null;
  }
};

const classifyRefreshFailure = async (response: Response): Promise<"retry" | "terminal"> => {
  const errorCode = await readAuthErrorCode(response);
  if (errorCode && TERMINAL_REFRESH_ERROR_CODES.has(errorCode)) {
    return "terminal";
  }
  if (RETRYABLE_REFRESH_STATUSES.has(response.status)) {
    return "retry";
  }
  if (response.status >= 400 && response.status < 500) {
    return "terminal";
  }

  throw new Error(
    `Unexpected Auth refresh response: ${response.status}${errorCode ? ` (${errorCode})` : ""}`,
  );
};

export const beginEmailVerificationLogin = async (input: {
  context: Readonly<RouterContextProvider>;
  userId: string;
}): Promise<Array<[string, string]>> => {
  const grant: EmailVerificationLoginGrant = {
    userId: input.userId,
    expiresAt: Date.now() + EMAIL_VERIFICATION_LOGIN_GRANT_TTL_SECONDS * 1_000,
  };

  return [
    ["Set-Cookie", await createEmailVerificationLoginGrantCookie(input.context).serialize(grant)],
  ];
};

export const completeEmailVerificationLogin = async (input: {
  request: Request;
  context: Readonly<RouterContextProvider>;
}): Promise<CompleteEmailVerificationLoginResult> => {
  const grant = await readEmailVerificationLoginGrant(input.request, input.context);
  if (!grant) {
    return {
      status: "unavailable",
      headers: await clearEmailVerificationLoginGrant(input.context),
    };
  }

  const auth = getAuthDurableObject(input.context);
  const issuance = await auth.issueVerifiedEmailCredential({ userId: grant.userId });
  if (issuance.status === "pending") {
    return { status: "pending", headers: [] };
  }
  if (issuance.status === "rejected") {
    return {
      status: "unavailable",
      headers: await clearEmailVerificationLoginGrant(input.context),
    };
  }

  const refreshResponse = await auth.fetch(
    new Request(new URL("/api/auth/token/refresh", input.request.url), {
      method: "POST",
      headers: {
        cookie: `${resolveRefreshCookieName()}=${encodeURIComponent(issuance.credentialToken)}`,
        "content-type": "application/json",
      },
      body: "{}",
    }),
  );
  if (!refreshResponse.ok) {
    const failure = await classifyRefreshFailure(refreshResponse);
    if (failure === "retry") {
      return { status: "pending", headers: [] };
    }
    return {
      status: "unavailable",
      headers: await clearEmailVerificationLoginGrant(input.context),
    };
  }

  return {
    status: "authenticated",
    headers: [
      ...getSetCookieHeaders(refreshResponse.headers).map(
        (value) => ["Set-Cookie", value] as [string, string],
      ),
      ...(await clearEmailVerificationLoginGrant(input.context)),
    ],
  };
};
