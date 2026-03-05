import { useState } from "react";
import { Form, Link, redirect, useActionData, useNavigation } from "react-router";
import { FormContainer, FormField } from "@/components/backoffice";
import { authClient } from "@/fragno/auth-client";
import { createAuthRouteCaller, getAuthMe } from "@/fragno/auth-server";
import type { Route } from "./+types/login";
import "../../backoffice.css";

type BackofficeLoginActionData = {
  ok: false;
  message: string;
};

export async function loader({ request, context }: Route.LoaderArgs) {
  if (import.meta.env.MODE !== "development") {
    throw new Response("Not Found", { status: 404 });
  }

  const me = await getAuthMe(request, context);
  if (me?.user) {
    return Response.redirect(new URL("/backoffice", request.url), 302);
  }

  return null;
}

export async function action({ request, context }: Route.ActionArgs) {
  if (import.meta.env.MODE !== "development") {
    throw new Response("Not Found", { status: 404 });
  }

  const formData = await request.formData();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return {
      ok: false,
      message: "Enter your email and password to continue.",
    } satisfies BackofficeLoginActionData;
  }

  try {
    const callAuthRoute = createAuthRouteCaller(request, context);
    const response = await callAuthRoute("POST", "/sign-in", {
      body: { email, password },
    });

    if (response.type === "error") {
      return {
        ok: false,
        message: response.error.message || "Unable to sign in.",
      } satisfies BackofficeLoginActionData;
    }

    if (response.type !== "json" && response.type !== "empty") {
      return {
        ok: false,
        message: "Unable to sign in.",
      } satisfies BackofficeLoginActionData;
    }

    return redirect("/backoffice", { headers: response.headers });
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Unable to sign in.",
    } satisfies BackofficeLoginActionData;
  }
}

export function meta() {
  return [
    { title: "Fragno Backoffice Login" },
    { name: "description", content: "Access the Fragno backoffice dashboard." },
  ];
}

export default function BackofficeLogin() {
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [oauthPending, setOauthPending] = useState(false);
  const actionData = useActionData<BackofficeLoginActionData>();
  const navigation = useNavigation();
  const passwordError = actionData?.message ?? null;
  const passwordPending = navigation.state === "submitting";

  const handleGithubSignIn = async () => {
    setOauthPending(true);
    setOauthError(null);

    try {
      const result = await authClient.oauth.getAuthorizationUrl({
        provider: "github",
        returnTo: "/backoffice",
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
          <p className="text-[11px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
            Fragno Backoffice
          </p>
          <h1 className="text-3xl font-semibold leading-tight text-[var(--bo-fg)] md:text-4xl">
            Technical control for docs, fragments, and team readiness.
          </h1>
          <p className="text-sm text-[var(--bo-muted)]">
            Review releases, audit changes, and coordinate framework owners without leaving the docs
            ecosystem.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              to="/docs"
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
            >
              Return to docs
            </Link>
          </div>
        </div>

        <div className="w-full max-w-md">
          <FormContainer
            title="Sign in"
            description="Use GitHub or your backoffice credentials to access the dashboard."
            eyebrow="Access"
          >
            <div className="space-y-3">
              <button
                type="button"
                onClick={handleGithubSignIn}
                disabled={oauthPending}
                className="w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
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
                <div className="border-t border-[color:var(--bo-border)] pt-4">
                  <p className="text-[11px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
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
                    required
                    placeholder="team@fragno.dev"
                    className="focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
                  />
                </FormField>
                <FormField label="Password" hint="Minimum 8 characters.">
                  <input
                    type="password"
                    name="password"
                    autoComplete="current-password"
                    required
                    placeholder="••••••••"
                    className="focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
                  />
                </FormField>
                {passwordError ? (
                  <p className="text-xs text-red-400">{passwordError}</p>
                ) : (
                  <p className="text-xs text-[var(--bo-muted-2)]">
                    Password sign-in is enabled for local development.
                  </p>
                )}
                <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
                  <button
                    type="submit"
                    disabled={passwordPending}
                    className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
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
                  className="font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent)] transition-colors hover:text-[var(--bo-accent-strong)]"
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
