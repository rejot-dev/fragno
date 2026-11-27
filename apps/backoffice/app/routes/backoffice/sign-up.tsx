import "@fragno-private/design-system/components.css";

import { Field } from "@fragno-private/design-system/controls/field";
import { Input } from "@fragno-private/design-system/controls/input";
import {
  PillArrow,
  PillButton,
  PillButtonLink,
  PillLabel,
} from "@fragno-private/design-system/controls/pill-button";
import { useState } from "react";
import { Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
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
import { getBackofficeObjects } from "@/worker-runtime/durable-objects";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/sign-up";
import { ACCESS_CODE_ERROR_CONTENT } from "./access-code-errors";
import {
  buildBackofficeLoginPath,
  buildBackofficeSignUpPath,
  readBackofficeReturnTo,
} from "./auth-navigation";
import { AuthAlert, AuthPage, GitHubButton, INK_LINK_CLASS_NAME, OrDivider } from "./auth-page";
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
    { title: "Leyway Sign Up" },
    { name: "description", content: "Create a Leyway account." },
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
  const signUpError = actionData?.state === "error" ? actionData.message : null;
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
  const showsAccessCodeField = access.kind === "access_code" && !(invited && !changingCode);

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
    <AuthPage
      title={
        verificationRequired
          ? "Check your email"
          : invited
            ? "Accept your invitation"
            : "Create an account"
      }
      description={
        verificationRequired
          ? `A verification link is being delivered to ${verificationRequired.email}.`
          : invited
            ? "Your invitation is ready. Choose an email and password, or continue with GitHub."
            : access.kind === "access_code"
              ? "Leyway is invitation-only for now. Use the access code from your invitation."
              : "Choose an email and password, or continue with GitHub."
      }
      alternative={
        verificationRequired
          ? null
          : {
              title: "Already have an account?",
              description: "Sign in to pick up where you left off.",
              label: "Sign in",
              to: buildBackofficeLoginPath(returnTo),
            }
      }
    >
      {verificationRequired ? (
        <>
          <p className="text-sm leading-6 text-pretty text-[var(--bo-muted)]">
            Open the link in the email before signing in. Delivery is retried automatically if the
            email provider is temporarily unavailable.
          </p>
          {verificationRequired.resend === "accepted" ? (
            <p role="status" className="text-xs text-[var(--bo-fg)]">
              If this unverified account exists, a new email will be sent.
            </p>
          ) : null}
          <PillButtonLink
            to={buildBackofficeLoginPath(returnTo)}
            variant="outlined"
            size="default"
            ring={true}
            className="w-full"
          >
            <PillLabel>Continue to sign in</PillLabel>
            <PillArrow />
          </PillButtonLink>
          <Form method="post" action={buildBackofficeSignUpPath(returnTo)}>
            <input type="hidden" name="intent" value="resend" />
            <input type="hidden" name="email" value={verificationRequired.email} />
            <PillButton
              type="submit"
              disabled={resendPending}
              variant="outlined"
              size="default"
              ring={false}
              className="w-full"
            >
              <PillLabel>{resendPending ? "Requesting…" : "Resend verification email"}</PillLabel>
            </PillButton>
          </Form>
        </>
      ) : (
        <>
          <Form method="post" action={signUpPath} className="space-y-4">
            {linkRejection ? (
              <AuthAlert title={linkRejection.title} message={linkRejection.message} />
            ) : null}
            {access.kind === "access_code" && !showsAccessCodeField ? (
              <div className="flex items-center justify-between gap-3 rounded-[10px] border border-[color:var(--bo-border)] bg-[color-mix(in_srgb,var(--bo-fg)_4%,var(--bo-panel))] px-4 py-3">
                <input type="hidden" name="accessCode" value={accessCode} />
                <div className="min-w-0">
                  <p className="text-xs text-[var(--bo-muted)]">Invitation code</p>
                  <p className="truncate font-mono text-sm text-[var(--bo-fg)]">{accessCode}</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setChangingCode(true);
                  }}
                  className={`text-xs ${INK_LINK_CLASS_NAME}`}
                >
                  Change
                </button>
              </div>
            ) : null}
            {showsAccessCodeField ? (
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
                  autoFocus
                  spellCheck={false}
                  placeholder="ABCD2345EFGH6789"
                  className="w-full font-mono uppercase"
                />
              </Field>
            ) : null}
            <Field label="Work email">
              <Input
                type="email"
                name="email"
                autoComplete="username"
                autoFocus={!showsAccessCodeField}
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
              <p role="alert" className="text-xs text-red-600">
                {signUpError}
              </p>
            ) : (
              <p className="text-xs text-[var(--bo-muted-2)]">
                Email verification may be required before signing in.
              </p>
            )}
            <PillButton
              type="submit"
              name="intent"
              value="sign_up"
              disabled={signUpPending}
              variant="outlined"
              size="default"
              ring={true}
              className="w-full"
            >
              <PillLabel>{signUpPending ? "Creating account…" : "Create account"}</PillLabel>
              <PillArrow />
            </PillButton>
          </Form>
          <OrDivider />
          <GitHubButton
            label={githubPending ? "Redirecting…" : "Sign up with GitHub"}
            disabled={githubPending || (access.kind === "access_code" && accessCode.trim() === "")}
            onClick={() => void signUpWithGitHub()}
          />
          {githubError ? (
            <AuthAlert title="GitHub sign-up could not be started" message={githubError} />
          ) : null}
        </>
      )}
    </AuthPage>
  );
}
