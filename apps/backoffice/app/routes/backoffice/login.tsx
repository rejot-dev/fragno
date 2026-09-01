import "../../backoffice.css";

import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { z } from "zod";

import { FormContainer, FormField } from "@/components/backoffice";
import { BackofficeFragmentMark } from "@/components/backoffice/fragment-mark";
import { authClient } from "@/fragno/auth/auth-client";
import {
  callBetterAuth,
  createBackofficeIdentityChangeHeaders,
  getBackofficeMe,
} from "@/fragno/auth/auth-server";
import { issueBackofficeTokenResultSchema } from "@/fragno/auth/contracts";
import { requestEmailVerificationResend } from "@/fragno/auth/email-verification.server";
import { readPreferredOrganization } from "@/fragno/auth/preferred-organization.client";
import { readBackofficeSessionExchangeErrorMessage } from "@/fragno/auth/session-exchange-error";
import { getSetCookieHeaders } from "@/worker-runtime/http-headers";

import type { Route } from "./+types/login";
import {
  buildBackofficeAuthBootstrapPath,
  buildBackofficeSignUpPath,
  readBackofficeReturnTo,
  retargetBackofficeOrganizationReturnTo,
} from "./auth-navigation";

type BackofficeLoginAuthError = {
  title: string;
  message: string;
};

type BackofficeLoginLoaderData = {
  authenticated: boolean;
  returnTo: string;
  bootstrapError: string | null;
  authError: BackofficeLoginAuthError | null;
};

type BackofficeLoginActionData =
  | {
      state: "error";
      message: string;
    }
  | {
      state: "verification_required";
      email: string;
      resend: "available" | "accepted";
      message: string;
    };

function requiresBetterAuthBrowserSession(returnTo: string): boolean {
  return new URL(returnTo, "http://localhost").pathname === "/backoffice/device";
}

const loginActionInputSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("sign_in"),
    email: z.string().trim().toLowerCase().pipe(z.email().max(191)),
    password: z.string().min(1),
    preferredOrganizationId: z.string().trim().default(""),
  }),
  z.object({
    intent: z.literal("resend"),
    email: z.string().trim().toLowerCase().pipe(z.email().max(191)),
  }),
]);

const organizationProvisioningResponseSchema = z.object({
  status: z.literal("organization_provisioning"),
  retryAfterMs: z.number().int().positive(),
});

const betterAuthErrorCodeSchema = z.enum([
  "invalid_callback_request",
  "invalid_code",
  "internal_server_error",
  "state_not_found",
  "state_invalid",
  "state_mismatch",
  "no_code",
  "no_callback_url",
  "oauth_provider_not_found",
  "email_not_found",
  "email_doesn't_match",
  "unable_to_get_user_info",
  "unable_to_link_account",
  "unable_to_create_user",
  "unable_to_create_session",
  "account_not_linked",
  "account_already_linked_to_different_user",
  "signup_disabled",
]);

type BetterAuthErrorCode = z.infer<typeof betterAuthErrorCodeSchema>;

const betterAuthErrorContent = {
  invalid_callback_request: {
    title: "The authentication response was invalid",
    message: "Start authentication again and retry.",
  },
  invalid_code: {
    title: "The authentication code is no longer valid",
    message: "Start authentication again and retry.",
  },
  internal_server_error: {
    title: "Authentication is temporarily unavailable",
    message: "Try again in a moment or use your email and password to continue.",
  },
  state_not_found: {
    title: "The authentication request could not be found",
    message: "Start authentication again and retry.",
  },
  state_invalid: {
    title: "The authentication request is invalid",
    message: "Start authentication again and retry.",
  },
  state_mismatch: {
    title: "The authentication request could not be verified",
    message: "Start authentication again and retry.",
  },
  no_code: {
    title: "The provider did not return an authentication code",
    message: "Try again or use your email and password to continue.",
  },
  no_callback_url: {
    title: "The authentication destination is missing",
    message: "Start authentication again and retry.",
  },
  oauth_provider_not_found: {
    title: "The authentication provider is unavailable",
    message: "Use another authentication method or try again later.",
  },
  email_not_found: {
    title: "No email address was provided",
    message: "Make an email address available to Backoffice through your provider, then try again.",
  },
  "email_doesn't_match": {
    title: "The account email does not match",
    message: "Use the provider account connected to your Backoffice email address.",
  },
  unable_to_get_user_info: {
    title: "Your account details could not be loaded",
    message: "Try again or use your email and password to continue.",
  },
  unable_to_link_account: {
    title: "The provider account could not be linked",
    message: "Sign in with your email and password before connecting this account.",
  },
  unable_to_create_user: {
    title: "Your Backoffice account could not be created",
    message: "Try again or use the sign-up link provided for your email address.",
  },
  unable_to_create_session: {
    title: "A Backoffice session could not be created",
    message: "Return to sign in and try again.",
  },
  account_not_linked: {
    title: "This provider account is not linked",
    message: "Sign in with your email and password before connecting this account.",
  },
  account_already_linked_to_different_user: {
    title: "This provider account is already linked",
    message: "Sign in with the Backoffice account that is already connected to it.",
  },
  signup_disabled: {
    title: "Account creation is not available",
    message: "Use an existing Backoffice account or open the invitation created for your email.",
  },
} satisfies Record<BetterAuthErrorCode, BackofficeLoginAuthError>;

function readBackofficeLoginAuthError(url: URL): BackofficeLoginAuthError | null {
  const error = url.searchParams.get("error");
  if (!error) {
    return null;
  }

  const parsedErrorCode = betterAuthErrorCodeSchema.safeParse(error);
  if (!parsedErrorCode.success) {
    return {
      title: "Authentication could not be completed",
      message: "Try again or use your Backoffice email and password to continue.",
    };
  }

  return betterAuthErrorContent[parsedErrorCode.data];
}

function mergeRequestCookiesWithResponseCookies(request: Request, response: Response): string {
  const cookies = new Map<string, string>();
  for (const cookie of request.headers.get("cookie")?.split(";") ?? []) {
    const separator = cookie.indexOf("=");
    if (separator > 0) {
      cookies.set(cookie.slice(0, separator).trim(), cookie.slice(separator + 1).trim());
    }
  }
  for (const setCookie of getSetCookieHeaders(response.headers)) {
    const cookie = setCookie.split(";", 1)[0];
    const separator = cookie.indexOf("=");
    if (separator > 0) {
      cookies.set(cookie.slice(0, separator).trim(), cookie.slice(separator + 1).trim());
    }
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function exchangeSignedInSessionForBackofficeJwt(
  request: Request,
  context: Route.ActionArgs["context"],
  signInResponse: Response,
  preferredOrganizationId: string | null,
): Promise<{
  response: Response;
  organizationId: string | null;
}> {
  const headers = new Headers(request.headers);
  headers.set("cookie", mergeRequestCookiesWithResponseCookies(request, signInResponse));
  const sessionRequest = new Request(request.url, { headers });
  const startedAt = Date.now();

  while (true) {
    const response = await callBetterAuth(sessionRequest, context, "/backoffice-token", {
      method: "POST",
      body: JSON.stringify({
        selection: "preferred",
        organizationId: preferredOrganizationId,
      }),
    });
    if (response.status !== 202) {
      if (!response.ok) {
        throw new Error(await readBackofficeSessionExchangeErrorMessage(response));
      }
      const result = issueBackofficeTokenResultSchema.parse(await response.clone().json());
      return { response, organizationId: result.organization?.id ?? null };
    }

    const provisioning = organizationProvisioningResponseSchema.parse(await response.json());
    if (Date.now() - startedAt + provisioning.retryAfterMs > 15_000) {
      throw new Error("Your organisation could not be created in time. Try signing in again.");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, provisioning.retryAfterMs);
    });
  }
}

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const returnTo = readBackofficeReturnTo(url);
  if (!requiresBetterAuthBrowserSession(returnTo)) {
    const jwtMe = await getBackofficeMe(request, context);
    if (jwtMe.status === "authenticated") {
      return redirect(returnTo);
    }
  }

  return {
    authenticated: false,
    returnTo,
    bootstrapError: null,
    authError: readBackofficeLoginAuthError(url),
  } satisfies BackofficeLoginLoaderData;
}

export async function action({ request, context, url }: Route.ActionArgs) {
  const formData = await request.formData();
  const returnTo = readBackofficeReturnTo(url);
  const input = loginActionInputSchema.safeParse(Object.fromEntries(formData));
  if (!input.success) {
    return {
      state: "error",
      message: "Enter a valid email address and password to continue.",
    } satisfies BackofficeLoginActionData;
  }

  if (input.data.intent === "resend") {
    const resend = await requestEmailVerificationResend({
      request,
      context,
      email: input.data.email,
    });
    return resend.status === "accepted"
      ? ({
          state: "verification_required",
          email: resend.email,
          resend: "accepted",
          message: "If this unverified account exists, a new email will be sent.",
        } satisfies BackofficeLoginActionData)
      : ({ state: "error", message: resend.message } satisfies BackofficeLoginActionData);
  }

  try {
    const response = await callBetterAuth(request, context, "/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: input.data.email, password: input.data.password }),
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as {
        code?: string;
        message?: string;
      } | null;
      const verificationRequired =
        error?.code === "EMAIL_NOT_VERIFIED" ||
        error?.message?.toLowerCase().includes("verify your email");
      return verificationRequired
        ? ({
            state: "verification_required",
            email: input.data.email,
            resend: "available",
            message: error?.message || "Verify your email before signing in.",
          } satisfies BackofficeLoginActionData)
        : ({
            state: "error",
            message: error?.message || "Unable to sign in.",
          } satisfies BackofficeLoginActionData);
    }
    const exchange = await exchangeSignedInSessionForBackofficeJwt(
      request,
      context,
      response,
      input.data.preferredOrganizationId || null,
    );
    const headers = createBackofficeIdentityChangeHeaders(response);
    for (const setCookie of getSetCookieHeaders(exchange.response.headers)) {
      headers.append("Set-Cookie", setCookie);
    }
    return redirect(retargetBackofficeOrganizationReturnTo(returnTo, exchange.organizationId), {
      headers,
    });
  } catch (error) {
    return {
      state: "error",
      message: error instanceof Error ? error.message : "Unable to sign in.",
    } satisfies BackofficeLoginActionData;
  }
}

export function meta() {
  return [
    { title: "Backoffice Login" },
    { name: "description", content: "Sign in to Backoffice." },
  ];
}

export default function BackofficeLogin() {
  const { authenticated, returnTo, bootstrapError, authError } =
    useLoaderData<BackofficeLoginLoaderData>();
  const [authErrorNotice, setAuthErrorNotice] = useState<BackofficeLoginAuthError | null>(
    authError,
  );
  const [oauthPending, setOauthPending] = useState(false);
  const actionData = useActionData<BackofficeLoginActionData>();
  const navigation = useNavigation();
  const passwordError = actionData?.message ?? null;
  const verificationRequired = actionData?.state === "verification_required" ? actionData : null;
  const submittedIntent = navigation.formData?.get("intent");
  const passwordPending = navigation.state === "submitting" && submittedIntent !== "resend";
  const resendPending = navigation.state === "submitting" && submittedIntent === "resend";

  if (authenticated) {
    return <BackofficeLoginBootstrap returnTo={returnTo} bootstrapError={bootstrapError} />;
  }

  const handleGithubSignIn = async () => {
    setOauthPending(true);
    setAuthErrorNotice(null);

    try {
      const callbackURL = new URL(
        buildBackofficeAuthBootstrapPath(returnTo),
        window.location.origin,
      ).toString();
      const result = await authClient.signIn.social({
        provider: "github",
        callbackURL,
        disableRedirect: true,
      });
      if (result.error) {
        throw new Error(result.error.message || "Unable to start GitHub sign-in.");
      }
      if (!result.data?.url) {
        throw new Error("GitHub authorization URL is missing.");
      }
      window.location.assign(result.data.url);
    } catch (error) {
      setAuthErrorNotice({
        title: "GitHub sign-in could not be started",
        message: error instanceof Error ? error.message : "Try GitHub again in a moment.",
      });
      setOauthPending(false);
    }
  };

  return (
    <div
      data-backoffice-root
      className="relative isolate min-h-screen bg-[var(--bo-bg)] text-[var(--bo-fg)]"
    >
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(0deg,rgba(var(--bo-overlay),0.96),rgba(var(--bo-overlay),0.96)),linear-gradient(90deg,rgba(var(--bo-grid),0.45)_1px,transparent_1px),linear-gradient(0deg,rgba(var(--bo-grid),0.45)_1px,transparent_1px)] bg-[size:100%_100%,28px_28px,28px_28px]" />
      <header className="relative mx-auto flex min-h-16 w-full max-w-[1180px] items-center justify-between px-5 sm:px-8 lg:px-12">
        <Link
          to="/"
          className="flex min-h-11 items-center gap-3 text-[10px] font-bold tracking-[0.16em] text-[var(--bo-fg)] uppercase no-underline"
          aria-label="ReJot Backoffice home"
        >
          <BackofficeFragmentMark size="md" />
          ReJot Backoffice
        </Link>
        <Link
          to="/"
          className="inline-flex min-h-11 items-center gap-2 text-[10px] font-bold tracking-[0.14em] text-[var(--bo-muted)] uppercase no-underline transition-colors duration-150 hover:text-[var(--bo-fg)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--bo-accent)]"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Back to home
        </Link>
      </header>

      <div className="relative mx-auto grid w-full max-w-[1180px] items-start gap-8 px-5 py-6 sm:px-8 sm:py-8 lg:min-h-[calc(100svh-4rem)] lg:grid-cols-[minmax(0,1fr)_28rem] lg:items-center lg:gap-12 lg:px-12 lg:py-12">
        <section className="hidden lg:order-1 lg:block">
          <h1 className="max-w-2xl text-[clamp(3rem,6vw,6rem)] leading-[0.92] font-[560] tracking-[-0.065em] text-balance">
            AI is a tool,
            <br />
            <span className="text-[var(--bo-muted-2)]">not a co-worker.</span>
          </h1>
          <p className="mt-7 max-w-xl text-sm leading-7 text-pretty text-[var(--bo-muted)]">
            Backoffice uses models to translate intent, generate interfaces, and write workflows.
            Execution remains deterministic, inspectable, and governed by your systems.
          </p>
        </section>

        <div className="order-1 w-full lg:order-2">
          <FormContainer
            title="Sign in"
            description="Continue with GitHub or use your email and password."
          >
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => void handleGithubSignIn()}
                disabled={oauthPending}
                className="flex w-full items-center justify-center gap-2 border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
              >
                {oauthPending ? "Redirecting…" : "Continue with GitHub"}
              </button>
              {authErrorNotice ? (
                <div
                  role="alert"
                  className="border-l-2 border-red-500 bg-red-500/5 px-3 py-3 text-pretty"
                >
                  <p className="text-[10px] font-semibold tracking-[0.18em] text-red-600 uppercase dark:text-red-400">
                    {authErrorNotice.title}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-red-600/90 dark:text-red-400/90">
                    {authErrorNotice.message}
                  </p>
                </div>
              ) : null}
              <Form
                method="post"
                className="space-y-3"
                onSubmit={(event) => {
                  const input = event.currentTarget.elements.namedItem("preferredOrganizationId");
                  if (input instanceof HTMLInputElement) {
                    input.value = readPreferredOrganization() ?? "";
                  }
                }}
              >
                <input type="hidden" name="preferredOrganizationId" />
                <div
                  className="flex items-center gap-3 pt-2 text-[10px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase"
                  role="separator"
                >
                  <span className="h-px flex-1 bg-[var(--bo-border)]" aria-hidden="true" />
                  <span>Or use a password</span>
                  <span className="h-px flex-1 bg-[var(--bo-border)]" aria-hidden="true" />
                </div>
                <FormField label="Email address">
                  <input
                    type="email"
                    name="email"
                    autoComplete="username"
                    defaultValue={verificationRequired?.email ?? ""}
                    required
                    placeholder="you@example.com"
                    className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
                  />
                </FormField>
                <FormField label="Password">
                  <input
                    type="password"
                    name="password"
                    autoComplete="current-password"
                    required
                    placeholder="••••••••"
                    className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
                  />
                </FormField>
                {passwordError ? (
                  <p
                    className={
                      verificationRequired
                        ? "text-xs text-[var(--bo-accent)]"
                        : "text-xs text-red-400"
                    }
                  >
                    {passwordError}
                  </p>
                ) : null}
                {verificationRequired?.email ? (
                  <button
                    type="submit"
                    name="intent"
                    value="resend"
                    formNoValidate
                    disabled={resendPending}
                    className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:opacity-60"
                  >
                    {resendPending ? "Requesting…" : "Resend verification email"}
                  </button>
                ) : null}
                <button
                  type="submit"
                  name="intent"
                  value="sign_in"
                  disabled={passwordPending}
                  className="w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
                >
                  {passwordPending ? "Signing in…" : "Sign in"}
                </button>
              </Form>
              <p className="border-t border-[color:var(--bo-border)] pt-4 text-xs text-[var(--bo-muted-2)]">
                Need an account?{" "}
                <Link
                  to={buildBackofficeSignUpPath(returnTo)}
                  className="font-semibold tracking-[0.22em] text-[var(--bo-accent)] uppercase transition-colors hover:text-[var(--bo-accent-strong)]"
                >
                  Create one
                </Link>
                .
              </p>
            </div>
          </FormContainer>
        </div>
      </div>
    </div>
  );
}

const bootstrapMessageForReturnTo = (returnTo: string) => {
  const pathname = new URL(returnTo, "http://localhost").pathname;
  return pathname.endsWith("/terminal") ? "Opening the terminal…" : "Opening backoffice…";
};

function BackofficeLoginBootstrap({
  returnTo,
  bootstrapError,
}: {
  returnTo: string;
  bootstrapError: string | null;
}) {
  return (
    <div
      data-backoffice-root
      className="relative isolate min-h-screen bg-[var(--bo-bg)] text-[var(--bo-fg)]"
    >
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(0deg,rgba(var(--bo-overlay),0.96),rgba(var(--bo-overlay),0.96)),linear-gradient(90deg,rgba(var(--bo-grid),0.45)_1px,transparent_1px),linear-gradient(0deg,rgba(var(--bo-grid),0.45)_1px,transparent_1px)] bg-[size:100%_100%,28px_28px,28px_28px]" />
      <div className="relative mx-auto flex min-h-screen max-w-5xl items-center justify-center px-4 py-8">
        <div className="w-full max-w-md">
          <FormContainer
            title="Preparing backoffice"
            description="Checking your backoffice session before continuing."
            eyebrow="Bootstrap"
          >
            <div className="space-y-3">
              {bootstrapError ? (
                <p className="text-sm text-red-400">{bootstrapError}</p>
              ) : (
                <p className="text-sm text-[var(--bo-muted)]">
                  {bootstrapMessageForReturnTo(returnTo)}
                </p>
              )}
              <Link
                to={returnTo}
                className="inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
              >
                Continue to backoffice
              </Link>
            </div>
          </FormContainer>
        </div>
      </div>
    </div>
  );
}
