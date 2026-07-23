import "../../backoffice.css";

import { useEffect, useState } from "react";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { z } from "zod";

import { FormContainer, FormField } from "@/components/backoffice";
import { authClient } from "@/fragno/auth/auth-client";
import { createAuthRouteCaller, getAuthMe } from "@/fragno/auth/auth-server";
import { requestEmailVerificationResend } from "@/fragno/auth/email-verification.server";

import type { Route } from "./+types/login";
import {
  BACKOFFICE_HOME_PATH,
  buildBackofficeLoginPath,
  readBackofficeReturnTo,
} from "./auth-navigation";

type BackofficeLoginLoaderData = {
  authenticated: boolean;
  returnTo: string;
  defaultOrganizationId: string;
  bootstrapError: string | null;
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

const loginActionInputSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("sign_in"),
    email: z.string().trim().toLowerCase().pipe(z.email().max(191)),
    password: z.string().min(1),
    activeOrganizationId: z.string().trim().optional(),
  }),
  z.object({
    intent: z.literal("resend"),
    email: z.string().trim().toLowerCase().pipe(z.email().max(191)),
  }),
]);

export async function loader({ request, context, url }: Route.LoaderArgs) {
  if (import.meta.env.MODE !== "development") {
    throw new Response("Not Found", { status: 404 });
  }

  const me = await getAuthMe(request, context);
  const returnTo = readBackofficeReturnTo(url);

  if (me?.user) {
    const currentActiveOrganizationId = me.activeOrganization?.organization.id ?? null;
    const nextActiveOrganizationId =
      currentActiveOrganizationId ?? me.organizations[0]?.organization.id ?? null;

    if (!nextActiveOrganizationId || nextActiveOrganizationId === currentActiveOrganizationId) {
      return redirect(returnTo);
    }

    try {
      const callAuthRoute = createAuthRouteCaller(request, context);
      const response = await callAuthRoute("POST", "/organizations/active", {
        body: { organizationId: nextActiveOrganizationId },
      });

      if (response.type === "error") {
        return {
          authenticated: true,
          returnTo,
          defaultOrganizationId: "",
          bootstrapError: response.error.message || "Unable to initialize the active organisation.",
        } satisfies BackofficeLoginLoaderData;
      }

      if (response.type !== "json" && response.type !== "empty") {
        return {
          authenticated: true,
          returnTo,
          defaultOrganizationId: "",
          bootstrapError: "Unable to initialize the active organisation.",
        } satisfies BackofficeLoginLoaderData;
      }

      return redirect(returnTo, { headers: response.headers });
    } catch (error) {
      return {
        authenticated: true,
        returnTo,
        defaultOrganizationId: "",
        bootstrapError:
          error instanceof Error ? error.message : "Unable to initialize the active organisation.",
      } satisfies BackofficeLoginLoaderData;
    }
  }

  return {
    authenticated: false,
    returnTo,
    defaultOrganizationId: "",
    bootstrapError: null,
  } satisfies BackofficeLoginLoaderData;
}

export async function clientLoader({ serverLoader }: Route.ClientLoaderArgs) {
  const serverData = await serverLoader();
  if (serverData.authenticated) {
    return serverData;
  }

  const defaultOrganizationId = authClient.defaultOrganization.read() ?? "";
  return { ...serverData, defaultOrganizationId };
}
clientLoader.hydrate = true;

export async function action({ request, context, url }: Route.ActionArgs) {
  if (import.meta.env.MODE !== "development") {
    throw new Response("Not Found", { status: 404 });
  }

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
    const callAuthRoute = createAuthRouteCaller(request, context);
    const response = await callAuthRoute("POST", "/sign-in", {
      body: {
        email: input.data.email,
        password: input.data.password,
        auth: input.data.activeOrganizationId
          ? { activeOrganizationId: input.data.activeOrganizationId }
          : undefined,
      },
    });

    if (response.type === "error") {
      return response.error.code === "email_verification_required"
        ? ({
            state: "verification_required",
            email: input.data.email,
            resend: "available",
            message: response.error.message || "Verify your email before signing in.",
          } satisfies BackofficeLoginActionData)
        : ({
            state: "error",
            message: response.error.message || "Unable to sign in.",
          } satisfies BackofficeLoginActionData);
    }

    if (response.type !== "json" && response.type !== "empty") {
      return {
        state: "error",
        message: "Unable to sign in.",
      } satisfies BackofficeLoginActionData;
    }

    return redirect(returnTo || BACKOFFICE_HOME_PATH, { headers: response.headers });
  } catch (error) {
    return {
      state: "error",
      message: error instanceof Error ? error.message : "Unable to sign in.",
    } satisfies BackofficeLoginActionData;
  }
}

export function meta() {
  return [
    { title: "Fragno Backoffice Login" },
    { name: "description", content: "Access the Fragno backoffice." },
  ];
}

export default function BackofficeLogin() {
  const {
    authenticated,
    returnTo,
    defaultOrganizationId: initialDefaultOrganizationId,
    bootstrapError,
  } = useLoaderData<BackofficeLoginLoaderData>();
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [oauthPending, setOauthPending] = useState(false);
  const [defaultOrganizationId, setDefaultOrganizationId] = useState(initialDefaultOrganizationId);
  const actionData = useActionData<BackofficeLoginActionData>();
  const navigation = useNavigation();
  const passwordError = actionData?.message ?? null;
  const verificationRequired = actionData?.state === "verification_required" ? actionData : null;
  const submittedIntent = navigation.formData?.get("intent");
  const passwordPending = navigation.state === "submitting" && submittedIntent !== "resend";
  const resendPending = navigation.state === "submitting" && submittedIntent === "resend";

  useEffect(() => {
    if (authenticated) {
      return;
    }

    const nextDefaultOrganizationId = authClient.defaultOrganization.read() ?? "";
    if (nextDefaultOrganizationId !== defaultOrganizationId) {
      setDefaultOrganizationId(nextDefaultOrganizationId);
    }
  }, [authenticated, defaultOrganizationId]);

  if (authenticated) {
    return <BackofficeLoginBootstrap returnTo={returnTo} bootstrapError={bootstrapError} />;
  }

  const handleGithubSignIn = async () => {
    setOauthPending(true);
    setOauthError(null);

    try {
      const preferredOrganizationId =
        authClient.defaultOrganization.read() || defaultOrganizationId;
      const result = await authClient.oauth.getAuthorizationUrl({
        provider: "github",
        returnTo: buildBackofficeLoginPath(returnTo),
        auth: preferredOrganizationId
          ? { activeOrganizationId: preferredOrganizationId }
          : undefined,
      });

      if (!result?.url) {
        throw new Error("GitHub authorization URL is missing.");
      }

      window.location.assign(result.url);
    } catch (error) {
      setOauthError(error instanceof Error ? error.message : "Unable to start GitHub sign-in.");
      setOauthPending(false);
    }
  };

  return (
    <div
      data-backoffice-root
      className="relative isolate min-h-screen bg-[var(--bo-bg)] text-[var(--bo-fg)]"
    >
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(0deg,rgba(var(--bo-overlay),0.96),rgba(var(--bo-overlay),0.96)),linear-gradient(90deg,rgba(var(--bo-grid),0.45)_1px,transparent_1px),linear-gradient(0deg,rgba(var(--bo-grid),0.45)_1px,transparent_1px)] bg-[size:100%_100%,28px_28px,28px_28px]" />
      <div className="relative mx-auto flex min-h-screen max-w-5xl flex-col items-center justify-center gap-6 px-4 py-8 lg:flex-row lg:items-center lg:justify-between">
        <div className="w-full max-w-xl space-y-4">
          <p className="text-[11px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
            Fragno Backoffice
          </p>
          <h1 className="text-3xl leading-tight font-semibold text-[var(--bo-fg)] md:text-4xl">
            Technical control for docs, fragments, and team readiness.
          </h1>
          <p className="text-sm text-[var(--bo-muted)]">
            Review releases, audit changes, and coordinate framework owners without leaving the docs
            ecosystem.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              to="/docs"
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
            >
              Return to docs
            </Link>
          </div>
        </div>

        <div className="w-full max-w-md">
          <FormContainer
            title="Sign in"
            description="Use GitHub or your backoffice credentials to access the backoffice."
            eyebrow="Access"
          >
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => void handleGithubSignIn()}
                disabled={oauthPending}
                className="w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
              >
                {oauthPending ? "Redirecting…" : "Continue with GitHub"}
              </button>
              {oauthError ? (
                <p className="text-xs text-red-400">{oauthError}</p>
              ) : (
                <p className="text-xs text-[var(--bo-muted-2)]">
                  GitHub access is required for release approvals.
                </p>
              )}
              <Form method="post" className="space-y-3">
                <input type="hidden" name="activeOrganizationId" value={defaultOrganizationId} />
                <div className="border-t border-[color:var(--bo-border)] pt-4">
                  <p className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                    Sign in with password
                  </p>
                  <p className="mt-1 text-xs text-[var(--bo-muted)]">
                    Use your backoffice email and password.
                  </p>
                </div>
                <FormField label="Email address" hint="Your backoffice username uses email.">
                  <input
                    type="email"
                    name="email"
                    autoComplete="username"
                    defaultValue={verificationRequired?.email ?? ""}
                    required
                    placeholder="team@fragno.dev"
                    className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
                  />
                </FormField>
                <FormField label="Password" hint="Minimum 8 characters.">
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
                ) : (
                  <p className="text-xs text-[var(--bo-muted-2)]">
                    Password sign-in is enabled for local development.
                  </p>
                )}
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
                <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
                  <button
                    type="submit"
                    name="intent"
                    value="sign_in"
                    disabled={passwordPending}
                    className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
                  >
                    {passwordPending ? "Signing in…" : "Sign in"}
                  </button>
                  <span className="text-xs text-[var(--bo-muted-2)]">
                    Contact an admin if you need access.
                  </span>
                </div>
              </Form>
              <p className="border-t border-[color:var(--bo-border)] pt-4 text-xs text-[var(--bo-muted-2)]">
                Need an account?{" "}
                <Link
                  to="/backoffice/sign-up"
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
