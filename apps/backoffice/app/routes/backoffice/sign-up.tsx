import "../../backoffice.css";

import { Form, Link, redirect, useActionData, useNavigation } from "react-router";
import { z } from "zod";

import { FormContainer, FormField } from "@/components/backoffice";
import { createAuthRouteCaller, getAuthMe } from "@/fragno/auth/auth-server";
import { requestEmailVerificationResend } from "@/fragno/auth/email-verification.server";

import type { Route } from "./+types/sign-up";

type BackofficeSignUpActionData =
  | {
      state: "error";
      message: string;
    }
  | {
      state: "verification_required";
      email: string;
      resend: "available" | "accepted";
    };

const signUpActionInputSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("sign_up"),
    email: z.string().trim().toLowerCase().pipe(z.email().max(191)),
    password: z.string().min(8).max(100),
    confirmPassword: z.string().min(1),
  }),
  z.object({
    intent: z.literal("resend"),
    email: z.string().trim().toLowerCase().pipe(z.email().max(191)),
  }),
]);

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
  const input = signUpActionInputSchema.safeParse(Object.fromEntries(formData));
  if (!input.success) {
    return {
      state: "error",
      message: "Enter a valid email and a password with at least 8 characters.",
    } satisfies BackofficeSignUpActionData;
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
        } satisfies BackofficeSignUpActionData)
      : ({ state: "error", message: resend.message } satisfies BackofficeSignUpActionData);
  }

  if (input.data.password !== input.data.confirmPassword) {
    return {
      state: "error",
      message: "Passwords do not match.",
    } satisfies BackofficeSignUpActionData;
  }

  try {
    const response = await createAuthRouteCaller(request, context)("POST", "/sign-up", {
      body: { email: input.data.email, password: input.data.password },
    });

    if (response.type === "error") {
      return {
        state: "error",
        message: response.error.message || "Unable to create an account.",
      } satisfies BackofficeSignUpActionData;
    }

    if (response.type !== "json") {
      return {
        state: "error",
        message: "Unable to create an account.",
      } satisfies BackofficeSignUpActionData;
    }

    if (response.data.status === "email_verification_required") {
      return {
        state: "verification_required",
        email: response.data.email,
        resend: "available",
      } satisfies BackofficeSignUpActionData;
    }

    return redirect("/backoffice", { headers: response.headers });
  } catch (error) {
    return {
      state: "error",
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
  const verificationRequired = actionData?.state === "verification_required" ? actionData : null;
  const signUpError = actionData?.state === "error" ? actionData.message : null;
  const submittedIntent = navigation.formData?.get("intent");
  const signUpPending = navigation.state === "submitting" && submittedIntent !== "resend";
  const resendPending = navigation.state === "submitting" && submittedIntent === "resend";

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
            Create a backoffice account for local development access.
          </h1>
          <p className="text-sm text-[var(--bo-muted)]">
            Set up an email and password to enter the backoffice and configure fragments locally.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              to="/backoffice/login"
              className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)]"
            >
              Back to sign in
            </Link>
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
            title={verificationRequired ? "Check your email" : "Create account"}
            description={
              verificationRequired
                ? `A verification link is being delivered to ${verificationRequired.email}.`
                : "Use your team email to create a backoffice login."
            }
            eyebrow={verificationRequired ? "Verification required" : "Get access"}
          >
            {verificationRequired ? (
              <div className="space-y-4">
                <p className="text-sm leading-6 text-[var(--bo-muted)]">
                  Open the link in the email before signing in. Delivery is retried automatically if
                  the email provider is temporarily unavailable.
                </p>
                {verificationRequired.resend === "accepted" ? (
                  <p className="text-xs text-[var(--bo-accent)]">
                    If this unverified account exists, a new email will be sent.
                  </p>
                ) : null}
                <Form method="post">
                  <input type="hidden" name="intent" value="resend" />
                  <input type="hidden" name="email" value={verificationRequired.email} />
                  <button
                    type="submit"
                    disabled={resendPending}
                    className="inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:opacity-60"
                  >
                    {resendPending ? "Requesting…" : "Resend verification email"}
                  </button>
                </Form>
                <Link
                  to="/backoffice/login"
                  className="inline-flex border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)]"
                >
                  Continue to sign in
                </Link>
              </div>
            ) : (
              <Form method="post" className="space-y-3">
                <FormField label="Work email" hint="Use the email tied to your team access.">
                  <input
                    type="email"
                    name="email"
                    autoComplete="username"
                    required
                    placeholder="team@fragno.dev"
                    className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
                  />
                </FormField>
                <FormField label="Create password" hint="At least 8 characters.">
                  <input
                    type="password"
                    name="password"
                    autoComplete="new-password"
                    required
                    placeholder="••••••••"
                    className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
                  />
                </FormField>
                <FormField label="Confirm password" hint="Re-type to confirm.">
                  <input
                    type="password"
                    name="confirmPassword"
                    autoComplete="new-password"
                    required
                    placeholder="••••••••"
                    className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
                  />
                </FormField>
                {signUpError ? (
                  <p className="text-xs text-red-400">{signUpError}</p>
                ) : (
                  <p className="text-xs text-[var(--bo-muted-2)]">
                    Email verification may be required before signing in.
                  </p>
                )}
                <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
                  <button
                    type="submit"
                    name="intent"
                    value="sign_up"
                    disabled={signUpPending}
                    className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
                  >
                    {signUpPending ? "Creating account…" : "Sign up"}
                  </button>
                  <span className="text-xs text-[var(--bo-muted-2)]">
                    Already registered?{" "}
                    <Link
                      to="/backoffice/login"
                      className="font-semibold tracking-[0.22em] text-[var(--bo-accent)] uppercase transition-colors hover:text-[var(--bo-accent-strong)]"
                    >
                      Sign in
                    </Link>
                    .
                  </span>
                </div>
              </Form>
            )}
          </FormContainer>
        </div>
      </div>
    </div>
  );
}
