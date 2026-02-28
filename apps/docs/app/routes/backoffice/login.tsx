import { useState } from "react";
import { Link } from "react-router";
import { FormContainer, FormField } from "@/components/backoffice";
import { authClient } from "@/fragno/auth-client";
import { getAuthMe } from "@/fragno/auth-server";
import type { Route } from "./+types/login";
import "../../backoffice.css";

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

export function meta() {
  return [
    { title: "Fragno Backoffice Login" },
    { name: "description", content: "Access the Fragno backoffice dashboard." },
  ];
}

export default function BackofficeLogin() {
  const [authError, setAuthError] = useState<string | null>(null);
  const [authPending, setAuthPending] = useState(false);

  const handleGithubSignIn = async () => {
    setAuthPending(true);
    setAuthError(null);

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
      setAuthError(error instanceof Error ? error.message : "Unable to start GitHub sign-in.");
      setAuthPending(false);
    }
  };

  return (
    <div
      data-backoffice-root
      className="relative isolate min-h-screen bg-[var(--bo-bg)] text-[var(--bo-fg)]"
    >
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(0deg,rgba(var(--bo-overlay),0.96),rgba(var(--bo-overlay),0.96)),linear-gradient(90deg,rgba(var(--bo-grid),0.45)_1px,transparent_1px),linear-gradient(0deg,rgba(var(--bo-grid),0.45)_1px,transparent_1px)] bg-[size:100%_100%,28px_28px,28px_28px]" />
      <div className="relative mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-xl space-y-4">
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
              to="/backoffice"
              className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)]"
            >
              View demo dashboard
            </Link>
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
            description="Connect your GitHub account to access the backoffice."
            eyebrow="Access"
          >
            <div className="space-y-3">
              <button
                type="button"
                onClick={handleGithubSignIn}
                disabled={authPending}
                className="w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
              >
                {authPending ? "Redirecting…" : "Continue with GitHub"}
              </button>
              {authError ? (
                <p className="text-xs text-red-400">{authError}</p>
              ) : (
                <p className="text-xs text-[var(--bo-muted-2)]">
                  GitHub access is required for release approvals.
                </p>
              )}
              <div className="border-t border-[color:var(--bo-border)] pt-4">
                <p className="text-[11px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
                  Request access
                </p>
                <p className="mt-1 text-xs text-[var(--bo-muted)]">
                  Accounts are approved in batches to keep audits crisp.
                </p>
              </div>
              <FormField label="Work email" hint="Use a team address for faster approval.">
                <input
                  type="email"
                  name="email"
                  placeholder="team@fragno.dev"
                  className="focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
                />
              </FormField>
              <FormField label="Role" hint="Share the release or docs role you own.">
                <input
                  type="text"
                  name="role"
                  placeholder="Engineering lead"
                  className="focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
                />
              </FormField>
              <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
                <button
                  type="button"
                  className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)]"
                >
                  Submit request
                </button>
                <span className="text-xs text-[var(--bo-muted-2)]">Reviewed within 24 hours.</span>
              </div>
            </div>
          </FormContainer>
        </div>
      </div>
    </div>
  );
}
