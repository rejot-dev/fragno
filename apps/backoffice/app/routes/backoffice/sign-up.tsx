import "@fragno-private/design-system/components.css";

import { Button, ButtonLink } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { FormContainer } from "@fragno-private/design-system/form-container";
import { Input } from "@fragno-private/design-system/input";
import { useState } from "react";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { z } from "zod";

import { ACCESS_CODE_QUERY_PARAMETER } from "@/fragno/access-codes/access-code";
import type { AccessCodeRejection } from "@/fragno/access-codes/contracts";
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
import { getBackofficeObjects } from "@/worker-runtime/durable-objects";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/sign-up";
import { ACCESS_CODE_ERROR_CONTENT } from "./access-code-errors";
import {
  buildBackofficeLoginPath,
  buildBackofficeSignUpPath,
  readBackofficeReturnTo,
} from "./auth-navigation";
import { startGitHubSignIn } from "./github-sign-in";

type BackofficeSignUpAccess =
  | { kind: "open" }
  /** The code from the sign-up link, or "" without one, and why it would not admit an account. */
  | { kind: "access_code"; code: string; rejection: AccessCodeRejection | null };

type BackofficeSignUpLoaderData = {
  returnTo: string;
  access: BackofficeSignUpAccess;
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

const resendFields = {
  intent: z.literal("resend"),
  email: z.string().trim().toLowerCase().pipe(z.email().max(191)),
};

const accessCodeSignUpActionInputSchema = z.discriminatedUnion("intent", [
  z.object({ ...passwordSignUpFields, accessCode: z.string().trim().min(1) }),
  z.object(resendFields),
]);

const openSignUpActionInputSchema = z.discriminatedUnion("intent", [
  z.object(passwordSignUpFields),
  z.object(resendFields),
]);

function buildBackofficeAccessCodeSignUpPath(returnTo: string, code: string): string {
  const url = new URL(buildBackofficeSignUpPath(returnTo), "http://localhost");
  url.searchParams.set(ACCESS_CODE_QUERY_PARAMETER, code);
  return `${url.pathname}${url.search}`;
}

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const returnTo = readBackofficeReturnTo(url);
  const me = await getBackofficeMe(request, context);
  if (me.status === "authenticated") {
    return redirect(returnTo);
  }

  const { signUpAccessCodesRequired } = context.get(BackofficeWorkerContext).runtime.config;
  if (!signUpAccessCodesRequired) {
    return { returnTo, access: { kind: "open" } } satisfies BackofficeSignUpLoaderData;
  }
  const code = url.searchParams.get(ACCESS_CODE_QUERY_PARAMETER)?.trim() ?? "";
  // Checking the link's code first tells people it will not work before they fill in the form.
  const check =
    code === ""
      ? null
      : await getBackofficeObjects(context).otp.singleton().commands.checkAccessCode({ code });
  return {
    returnTo,
    access: { kind: "access_code", code, rejection: check?.ok === false ? check.reason : null },
  } satisfies BackofficeSignUpLoaderData;
}

export async function action({ request, context, url }: Route.ActionArgs) {
  const formData = await request.formData();
  const returnTo = readBackofficeReturnTo(url);
  const { signUpAccessCodesRequired } = context.get(BackofficeWorkerContext).runtime.config;
  const input = (
    signUpAccessCodesRequired ? accessCodeSignUpActionInputSchema : openSignUpActionInputSchema
  ).safeParse(Object.fromEntries(formData));
  if (!input.success) {
    return {
      state: "error",
      message: signUpAccessCodesRequired
        ? "Enter your access code, a valid email, and a password with at least 8 characters."
        : "Enter a valid email and a password with at least 8 characters.",
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
    const response = await callBetterAuth(request, context, "/sign-up/email", {
      method: "POST",
      body: JSON.stringify({
        name: input.data.email.split("@", 1)[0] || input.data.email,
        email: input.data.email,
        password: input.data.password,
        ...("accessCode" in input.data ? { accessCode: input.data.accessCode } : {}),
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
  const { returnTo, access } = useLoaderData<BackofficeSignUpLoaderData>();
  const actionData = useActionData<BackofficeSignUpActionData>();
  const navigation = useNavigation();
  const [accessCode, setAccessCode] = useState(access.kind === "access_code" ? access.code : "");
  // A link whose code works is an invitation; its code stays out of the way unless changed.
  const invited = access.kind === "access_code" && access.code !== "" && access.rejection === null;
  const [changingCode, setChangingCode] = useState(false);
  const [githubPending, setGithubPending] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const verificationRequired = actionData?.state === "verification_required" ? actionData : null;
  const signUpError = actionData?.state === "error" ? actionData.message : githubError;
  const submittedIntent = navigation.formData?.get("intent");
  const signUpPending = navigation.state === "submitting" && submittedIntent !== "resend";
  const resendPending = navigation.state === "submitting" && submittedIntent === "resend";
  const linkRejection =
    access.kind === "access_code" && access.rejection !== null
      ? ACCESS_CODE_ERROR_CONTENT[`access_code_${access.rejection}`]
      : null;
  const signUpPath =
    access.kind === "access_code" && access.code !== ""
      ? buildBackofficeAccessCodeSignUpPath(returnTo, access.code)
      : buildBackofficeSignUpPath(returnTo);

  const signUpWithGitHub = async () => {
    setGithubPending(true);
    setGithubError(null);
    try {
      await startGitHubSignIn({
        returnTo,
        oauthQuery: null,
        accessCode: access.kind === "access_code" ? accessCode.trim() : null,
      });
    } catch (error) {
      setGithubError(error instanceof Error ? error.message : "Try GitHub again in a moment.");
      setGithubPending(false);
    }
  };

  return (
    <BackofficeStandaloneLayout headerEnd={<BackToHomeLink />}>
      <div className="mx-auto grid w-full max-w-[1180px] flex-1 items-start gap-8 px-5 py-6 sm:px-8 sm:py-8 lg:grid-cols-[minmax(0,1fr)_28rem] lg:items-center lg:gap-12 lg:px-12 lg:py-12">
        <section>
          {invited ? (
            <>
              <p className="text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent)] uppercase">
                Invitation
              </p>
              <h1 className="mt-3 max-w-2xl text-[clamp(2.25rem,6vw,6rem)] leading-[0.92] font-[560] tracking-[-0.065em] text-balance">
                You&rsquo;re invited.
                <br />
                <span className="text-[var(--bo-muted-2)]">Welcome to Backoffice.</span>
              </h1>
              <p className="mt-5 max-w-xl text-sm leading-7 text-pretty text-[var(--bo-muted)] lg:mt-7">
                Your invitation is ready. Create your account to get started.
              </p>
            </>
          ) : (
            <>
              <h1 className="max-w-2xl text-[clamp(2.25rem,6vw,6rem)] leading-[0.92] font-[560] tracking-[-0.065em] text-balance">
                Create your
                <br />
                <span className="text-[var(--bo-muted-2)]">Backoffice account.</span>
              </h1>
              <p className="mt-5 max-w-xl text-sm leading-7 text-pretty text-[var(--bo-muted)] lg:mt-7">
                {access.kind === "access_code"
                  ? "Backoffice is invitation-only for now. Sign up with the access code from your invitation."
                  : "Register your email to access Backoffice."}
              </p>
            </>
          )}
        </section>

        <div className="w-full">
          <FormContainer
            title={
              verificationRequired
                ? "Check your email"
                : invited
                  ? "Accept your invitation"
                  : "Create account"
            }
            description={
              verificationRequired
                ? `A verification link is being delivered to ${verificationRequired.email}.`
                : "Continue with GitHub or choose an email and password."
            }
            eyebrow={verificationRequired ? "Verification required" : undefined}
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
            ) : (
              <Form method="post" action={signUpPath} className="space-y-3">
                {linkRejection ? (
                  <div
                    role="alert"
                    className="border-l-2 border-red-500 bg-red-500/5 px-3 py-3 text-pretty"
                  >
                    <p className="text-[10px] font-semibold tracking-[0.18em] text-red-600 uppercase dark:text-red-400">
                      {linkRejection.title}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-red-600/90 dark:text-red-400/90">
                      {linkRejection.message}
                    </p>
                  </div>
                ) : null}
                {access.kind === "access_code" && invited && !changingCode ? (
                  <div className="flex items-center justify-between gap-3 rounded-[4px] border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2">
                    <input type="hidden" name="accessCode" value={accessCode} />
                    <div className="min-w-0">
                      <p className="text-[10px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                        Invitation code
                      </p>
                      <p className="truncate font-mono text-sm text-[var(--bo-fg)]">{accessCode}</p>
                    </div>
                    <Button
                      variant="secondary"
                      type="button"
                      onClick={() => {
                        setChangingCode(true);
                      }}
                    >
                      Change
                    </Button>
                  </div>
                ) : access.kind === "access_code" ? (
                  <Field
                    label="Access code"
                    description="From your invitation link, or as an administrator gave it to you."
                  >
                    <Input
                      name="accessCode"
                      value={accessCode}
                      onChange={(event) => {
                        setAccessCode(event.target.value);
                      }}
                      required
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="ABCD2345EFGH6789"
                      className="w-full font-mono uppercase"
                    />
                  </Field>
                ) : null}
                <Button
                  variant="accent"
                  type="button"
                  onClick={() => void signUpWithGitHub()}
                  disabled={
                    githubPending || (access.kind === "access_code" && accessCode.trim() === "")
                  }
                  className="w-full"
                >
                  {githubPending ? "Redirecting…" : "Sign up with GitHub"}
                </Button>
                <div
                  className="flex items-center gap-3 pt-2 text-[10px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase"
                  role="separator"
                >
                  <span className="h-px flex-1 bg-[var(--bo-border)]" aria-hidden="true" />
                  <span>Or use a password</span>
                  <span className="h-px flex-1 bg-[var(--bo-border)]" aria-hidden="true" />
                </div>
                <Field label="Work email">
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
                  <p role="alert" className="text-xs text-red-400">
                    {signUpError}
                  </p>
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
