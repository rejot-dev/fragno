import "../../backoffice.css";

import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { z } from "zod";

import { FormContainer, FormField } from "@/components/backoffice";
import {
  callBetterAuth,
  createBackofficeIdentityChangeHeaders,
  getBackofficeMe,
} from "@/fragno/auth/auth-server";
import { requestEmailVerificationResend } from "@/fragno/auth/email-verification.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/sign-up";
import {
  buildBackofficeAuthBootstrapPath,
  buildBackofficeLoginPath,
  buildBackofficeSignUpPath,
  readBackofficeReturnTo,
} from "./auth-navigation";

type BackofficeSignUpInvitation = {
  invitationId: string;
  code: string;
};

type BackofficeSignUpLoaderData = {
  returnTo: string;
  invitation: BackofficeSignUpInvitation | null;
  signUpInvitationsEnabled: boolean;
};

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

const passwordSignUpFields = {
  intent: z.literal("sign_up"),
  email: z.string().trim().toLowerCase().pipe(z.email().max(191)),
  password: z.string().min(8).max(100),
  confirmPassword: z.string().min(1),
};

const invitedPasswordSignUpActionInputSchema = z.object({
  ...passwordSignUpFields,
  invitationId: z.string().trim().min(1),
  invitationCode: z.string().trim().min(1),
});

const invitedSignUpActionInputSchema = z.discriminatedUnion("intent", [
  invitedPasswordSignUpActionInputSchema,
  z.object({
    intent: z.literal("resend"),
    email: z.string().trim().toLowerCase().pipe(z.email().max(191)),
  }),
]);

const openSignUpActionInputSchema = z.discriminatedUnion("intent", [
  z.object(passwordSignUpFields),
  z.object({
    intent: z.literal("resend"),
    email: z.string().trim().toLowerCase().pipe(z.email().max(191)),
  }),
]);

function readBackofficeSignUpInvitation(url: URL): BackofficeSignUpInvitation | null {
  const invitationId = url.searchParams.get("invitationId")?.trim();
  const code = url.searchParams.get("code")?.trim();
  return invitationId && code ? { invitationId, code } : null;
}

function buildBackofficeInvitedSignUpPath(
  returnTo: string,
  invitation: BackofficeSignUpInvitation,
): string {
  const url = new URL(buildBackofficeSignUpPath(returnTo), "http://localhost");
  url.searchParams.set("invitationId", invitation.invitationId);
  url.searchParams.set("code", invitation.code);
  return `${url.pathname}${url.search}`;
}

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const returnTo = readBackofficeReturnTo(url);
  const me = await getBackofficeMe(request, context);
  if (me.status === "authenticated") {
    return redirect(returnTo);
  }

  const { signUpInvitationsEnabled } = context.get(BackofficeWorkerContext).runtime.config;
  return {
    returnTo,
    invitation: readBackofficeSignUpInvitation(url),
    signUpInvitationsEnabled,
  } satisfies BackofficeSignUpLoaderData;
}

export async function action({ request, context, url }: Route.ActionArgs) {
  const formData = await request.formData();
  const returnTo = readBackofficeReturnTo(url);
  const { signUpInvitationsEnabled } = context.get(BackofficeWorkerContext).runtime.config;
  const inputSchema = signUpInvitationsEnabled
    ? invitedSignUpActionInputSchema
    : openSignUpActionInputSchema;
  const input = inputSchema.safeParse(Object.fromEntries(formData));
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

  const invitationCredentials = signUpInvitationsEnabled
    ? invitedPasswordSignUpActionInputSchema.parse(input.data)
    : null;

  try {
    const response = await callBetterAuth(request, context, "/sign-up/email", {
      method: "POST",
      body: JSON.stringify({
        name: input.data.email.split("@", 1)[0] || input.data.email,
        email: input.data.email,
        password: input.data.password,
        ...(invitationCredentials
          ? {
              invitationId: invitationCredentials.invitationId,
              invitationCode: invitationCredentials.invitationCode,
            }
          : {}),
        callbackURL: buildBackofficeLoginPath(returnTo),
      }),
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as { message?: string } | null;
      return {
        state: "error",
        message: error?.message || "Unable to create an account.",
      } satisfies BackofficeSignUpActionData;
    }
    if (response.headers.has("set-cookie")) {
      return redirect(buildBackofficeAuthBootstrapPath(returnTo), {
        headers: createBackofficeIdentityChangeHeaders(response),
      });
    }
    return {
      state: "verification_required",
      email: input.data.email,
      resend: "available",
    } satisfies BackofficeSignUpActionData;
  } catch (error) {
    return {
      state: "error",
      message: error instanceof Error ? error.message : "Unable to create an account.",
    } satisfies BackofficeSignUpActionData;
  }
}

export function meta() {
  return [
    { title: "Backoffice Sign Up" },
    { name: "description", content: "Create a Backoffice account." },
  ];
}

export default function BackofficeSignUp() {
  const { returnTo, invitation, signUpInvitationsEnabled } =
    useLoaderData<BackofficeSignUpLoaderData>();
  const actionData = useActionData<BackofficeSignUpActionData>();
  const navigation = useNavigation();
  const verificationRequired = actionData?.state === "verification_required" ? actionData : null;
  const signUpError = actionData?.state === "error" ? actionData.message : null;
  const submittedIntent = navigation.formData?.get("intent");
  const signUpPending = navigation.state === "submitting" && submittedIntent !== "resend";
  const resendPending = navigation.state === "submitting" && submittedIntent === "resend";
  const activeInvitation = signUpInvitationsEnabled ? invitation : null;
  const signUpAllowed = !signUpInvitationsEnabled || activeInvitation !== null;
  const signUpPath = activeInvitation
    ? buildBackofficeInvitedSignUpPath(returnTo, activeInvitation)
    : buildBackofficeSignUpPath(returnTo);

  return (
    <div
      data-backoffice-root
      className="relative isolate min-h-screen bg-[var(--bo-bg)] text-[var(--bo-fg)]"
    >
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(0deg,rgba(var(--bo-overlay),0.96),rgba(var(--bo-overlay),0.96)),linear-gradient(90deg,rgba(var(--bo-grid),0.45)_1px,transparent_1px),linear-gradient(0deg,rgba(var(--bo-grid),0.45)_1px,transparent_1px)] bg-[size:100%_100%,28px_28px,28px_28px]" />
      <div className="relative mx-auto flex min-h-screen max-w-5xl flex-col items-center justify-center gap-6 px-4 py-8 lg:flex-row lg:items-center lg:justify-between">
        <div className="w-full max-w-xl space-y-4">
          <p className="text-[11px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
            Backoffice
          </p>
          <h1 className="text-3xl leading-tight font-semibold text-[var(--bo-fg)] md:text-4xl">
            Create your Backoffice account.
          </h1>
          <p className="text-sm text-[var(--bo-muted)]">
            Register your email to access Backoffice.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              to={buildBackofficeLoginPath(returnTo)}
              className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)]"
            >
              Back to sign in
            </Link>
          </div>
        </div>

        <div className="w-full max-w-md">
          <FormContainer
            title={
              verificationRequired
                ? "Check your email"
                : signUpAllowed
                  ? "Create account"
                  : "Invitation required"
            }
            description={
              verificationRequired
                ? `A verification link is being delivered to ${verificationRequired.email}.`
                : activeInvitation
                  ? "Use the invited email to create a backoffice login."
                  : signUpInvitationsEnabled
                    ? "Open the sign-up link created for your email address."
                    : "Use your team email to create a backoffice login."
            }
            eyebrow={
              verificationRequired
                ? "Verification required"
                : signUpAllowed
                  ? "Get access"
                  : "Invite only"
            }
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
                <Form method="post" action={buildBackofficeSignUpPath(returnTo)}>
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
                  to={buildBackofficeLoginPath(returnTo)}
                  className="inline-flex border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)]"
                >
                  Continue to sign in
                </Link>
              </div>
            ) : !signUpAllowed ? (
              <div className="space-y-4">
                <p className="text-sm leading-6 text-[var(--bo-muted)]">
                  Ask a Backoffice administrator to create a sign-up invitation for your email.
                </p>
                <Link
                  to={buildBackofficeLoginPath(returnTo)}
                  className="inline-flex border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)]"
                >
                  Back to sign in
                </Link>
              </div>
            ) : (
              <Form method="post" action={signUpPath} className="space-y-3">
                {activeInvitation ? (
                  <>
                    <input
                      type="hidden"
                      name="invitationId"
                      value={activeInvitation.invitationId}
                    />
                    <input type="hidden" name="invitationCode" value={activeInvitation.code} />
                  </>
                ) : null}
                <FormField
                  label="Work email"
                  hint={
                    activeInvitation
                      ? "Use the email tied to your invitation."
                      : "Use the email tied to your team access."
                  }
                >
                  <input
                    type="email"
                    name="email"
                    autoComplete="username"
                    required
                    placeholder="team@example.com"
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
                      to={buildBackofficeLoginPath(returnTo)}
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
