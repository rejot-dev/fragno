import { Form, Link, redirect, useActionData, useNavigation } from "react-router";
import { FormContainer, FormField } from "@/components/backoffice";
import { createAuthRouteCaller, getAuthMe } from "@/fragno/auth-server";
import type { Route } from "./+types/sign-up";
import "../../backoffice.css";

type BackofficeSignUpActionData = {
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
  const email = String(formData.get("signUpEmail") ?? "").trim();
  const password = String(formData.get("signUpPassword") ?? "");
  const confirmPassword = String(formData.get("signUpPasswordConfirm") ?? "");

  if (!email || !password || !confirmPassword) {
    return {
      ok: false,
      message: "Fill out email and password to create an account.",
    } satisfies BackofficeSignUpActionData;
  }

  if (password !== confirmPassword) {
    return {
      ok: false,
      message: "Passwords do not match.",
    } satisfies BackofficeSignUpActionData;
  }

  try {
    const callAuthRoute = createAuthRouteCaller(request, context);
    const response = await callAuthRoute("POST", "/sign-up", {
      body: { email, password },
    });

    if (response.type === "error") {
      return {
        ok: false,
        message: response.error.message || "Unable to create an account.",
      } satisfies BackofficeSignUpActionData;
    }

    if (response.type !== "json" && response.type !== "empty") {
      return {
        ok: false,
        message: "Unable to create an account.",
      } satisfies BackofficeSignUpActionData;
    }

    return redirect("/backoffice", { headers: response.headers });
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Unable to create an account.",
    } satisfies BackofficeSignUpActionData;
  }
}

export function meta() {
  return [
    { title: "Fragno Backoffice Sign Up" },
    { name: "description", content: "Create a backoffice account for local development." },
  ];
}

export default function BackofficeSignUp() {
  const actionData = useActionData<BackofficeSignUpActionData>();
  const navigation = useNavigation();
  const signUpError = actionData?.message ?? null;
  const signUpPending = navigation.state === "submitting";

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
            Create a backoffice account for local development access.
          </h1>
          <p className="text-sm text-[var(--bo-muted)]">
            Set up an email and password to enter the backoffice dashboard and configure fragments
            locally.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              to="/backoffice/login"
              className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)]"
            >
              Back to sign in
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
            title="Create account"
            description="Use your team email to create a backoffice login."
            eyebrow="Get access"
          >
            <Form method="post" className="space-y-3">
              <FormField label="Work email" hint="Use the email tied to your team access.">
                <input
                  type="email"
                  name="signUpEmail"
                  autoComplete="username"
                  required
                  placeholder="team@fragno.dev"
                  className="focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
                />
              </FormField>
              <FormField label="Create password" hint="At least 8 characters.">
                <input
                  type="password"
                  name="signUpPassword"
                  autoComplete="new-password"
                  required
                  placeholder="••••••••"
                  className="focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
                />
              </FormField>
              <FormField label="Confirm password" hint="Re-type to confirm.">
                <input
                  type="password"
                  name="signUpPasswordConfirm"
                  autoComplete="new-password"
                  required
                  placeholder="••••••••"
                  className="focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
                />
              </FormField>
              {signUpError ? (
                <p className="text-xs text-red-400">{signUpError}</p>
              ) : (
                <p className="text-xs text-[var(--bo-muted-2)]">
                  Created accounts are active immediately in development.
                </p>
              )}
              <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
                <button
                  type="submit"
                  disabled={signUpPending}
                  className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
                >
                  {signUpPending ? "Creating account…" : "Sign up"}
                </button>
                <span className="text-xs text-[var(--bo-muted-2)]">
                  Already registered?{" "}
                  <Link
                    to="/backoffice/login"
                    className="font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent)] transition-colors hover:text-[var(--bo-accent-strong)]"
                  >
                    Sign in
                  </Link>
                  .
                </span>
              </div>
            </Form>
          </FormContainer>
        </div>
      </div>
    </div>
  );
}
