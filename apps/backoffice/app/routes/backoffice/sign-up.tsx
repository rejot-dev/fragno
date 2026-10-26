import "@fragno-private/design-system/components.css";

import { Button, ButtonLink } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { FormContainer } from "@fragno-private/design-system/form-container";
import { Input } from "@fragno-private/design-system/input";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { z } from "zod";

import {
  callBetterAuth,
  createBackofficeIdentityChangeHeaders,
  getBackofficeMe,
} from "@/fragno/auth/auth-server";
import { requestEmailVerificationResend } from "@/fragno/auth/email-verification.server";
import {
  BACKOFFICE_PASSWORD_MIN_LENGTH,
  BACKOFFICE_PASSWORD_MAX_LENGTH,
} from "@/fragno/auth/password-policy";
import { BackofficeStandaloneLayout, BackToHomeLink } from "@/layouts/backoffice-standalone-layout";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/sign-up";
import {
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
  password: z.string().min(BACKOFFICE_PASSWORD_MIN_LENGTH).max(BACKOFFICE_PASSWORD_MAX_LENGTH),
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
      return redirect(returnTo, {
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
    <BackofficeStandaloneLayout headerEnd={<BackToHomeLink />}>
      <div className="mx-auto grid w-full max-w-[1180px] flex-1 items-start gap-8 px-5 py-6 sm:px-8 sm:py-8 lg:grid-cols-[minmax(0,1fr)_28rem] lg:items-center lg:gap-12 lg:px-12 lg:py-12">
        <section className="space-y-4">
          <h1 className="text-3xl leading-tight font-semibold text-[var(--bo-fg)] md:text-4xl">
            Create your Backoffice account.
          </h1>
          <p className="text-sm text-[var(--bo-muted)]">
            Register your email to access Backoffice.
          </p>
          <div className="flex flex-wrap gap-2">
            <ButtonLink variant="accent" to={buildBackofficeLoginPath(returnTo)}>
              Back to sign in
            </ButtonLink>
          </div>
        </section>

        <div className="w-full">
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
                  <Button variant="secondary" type="submit" disabled={resendPending}>
                    {resendPending ? "Requesting…" : "Resend verification email"}
                  </Button>
                </Form>
                <ButtonLink variant="accent" to={buildBackofficeLoginPath(returnTo)}>
                  Continue to sign in
                </ButtonLink>
              </div>
            ) : !signUpAllowed ? (
              <div className="space-y-4">
                <p className="text-sm leading-6 text-[var(--bo-muted)]">
                  Ask a Backoffice administrator to create a sign-up invitation for your email.
                </p>
                <ButtonLink variant="accent" to={buildBackofficeLoginPath(returnTo)}>
                  Back to sign in
                </ButtonLink>
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
                <Field
                  label="Work email"
                  description={
                    activeInvitation
                      ? "Use the email tied to your invitation."
                      : "Use the email tied to your team access."
                  }
                >
                  <Input
                    type="email"
                    name="email"
                    autoComplete="username"
                    required
                    placeholder="team@example.com"
                    className="w-full"
                  />
                </Field>
                <Field label="Create password" description="At least 8 characters.">
                  <Input
                    type="password"
                    name="password"
                    autoComplete="new-password"
                    required
                    placeholder="••••••••"
                    className="w-full"
                  />
                </Field>
                <Field label="Confirm password" description="Re-type to confirm.">
                  <Input
                    type="password"
                    name="confirmPassword"
                    autoComplete="new-password"
                    required
                    placeholder="••••••••"
                    className="w-full"
                  />
                </Field>
                {signUpError ? (
                  <p className="text-xs text-red-400">{signUpError}</p>
                ) : (
                  <p className="text-xs text-[var(--bo-muted-2)]">
                    Email verification may be required before signing in.
                  </p>
                )}
                <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
                  <Button
                    variant="accent"
                    type="submit"
                    name="intent"
                    value="sign_up"
                    disabled={signUpPending}
                  >
                    {signUpPending ? "Creating account…" : "Sign up"}
                  </Button>
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
    </BackofficeStandaloneLayout>
  );
}
