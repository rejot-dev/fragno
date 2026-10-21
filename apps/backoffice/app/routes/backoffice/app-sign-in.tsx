import { AppAuthLayout } from "@fragno-private/design-system/app-auth-layout";
import { Button } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { Input } from "@fragno-private/design-system/input";
import { useEffect, useState } from "react";
import { Form, Link, useLocation, useNavigation } from "react-router";

import type { AppSignInActionData, AppSignInPage } from "./app-sign-in.server";
import { startGitHubSignIn } from "./github-sign-in";

const RESEND_AFTER_SECONDS = 60;

/**
 * Seconds until another code may be sent, counted from the last code that went out; the server
 * limits how often codes go out. Rejected attempts send nothing, so they leave the count running.
 */
function useResendCountdown(actionData: AppSignInActionData | undefined): number {
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (actionData?.step === "code" && actionData.outcome.kind !== "rejected") {
      const sent = Date.now();
      setSentAt(sent);
      setNow(sent);
    }
  }, [actionData]);
  useEffect(() => {
    if (sentAt === null) {
      return undefined;
    }
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current - sentAt >= RESEND_AFTER_SECONDS * 1000) {
        clearInterval(timer);
      }
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [sentAt]);
  return sentAt === null
    ? 0
    : Math.max(0, Math.ceil((sentAt + RESEND_AFTER_SECONDS * 1000 - now) / 1000));
}

/**
 * Sign-in for people a first-party app sends here: their email, then a code from it or their
 * password, or GitHub. The code also creates an account for a new address, so nobody chooses
 * between signing in and signing up.
 */
export function AppSignIn({
  page,
  actionData,
}: {
  page: AppSignInPage;
  actionData: AppSignInActionData | undefined;
}) {
  const { branding } = page;
  const navigation = useNavigation();
  const pending = navigation.state === "submitting";
  const submittedIntent = navigation.formData?.get("intent");
  const resendIn = useResendCountdown(actionData);
  const location = useLocation();
  const [githubPending, setGithubPending] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const continueWithGitHub = async () => {
    setGithubPending(true);
    setGithubError(null);
    try {
      await startGitHubSignIn({
        returnTo: `/backoffice/oauth/consent?${page.oauthQuery}`,
        oauthQuery: page.oauthQuery,
      });
    } catch (error) {
      setGithubError(error instanceof Error ? error.message : "Try GitHub again in a moment.");
      setGithubPending(false);
    }
  };
  const brand = {
    name: branding.displayName,
    logoUrl: branding.logoUrl,
    accentColor: branding.accentColor,
    homeUrl: branding.homeUrl,
    supportUrl: branding.supportUrl,
  };

  if (actionData?.step === "code") {
    return (
      <AppAuthLayout
        brand={brand}
        title="Check your email"
        description={
          <>
            We sent a 6-digit code to{" "}
            <strong className="text-[var(--bo-fg)]">{actionData.email}</strong>. It can take a
            minute to arrive.
          </>
        }
      >
        <Form method="post" className="space-y-4">
          <input type="hidden" name="email" value={actionData.email} />
          <Field label="Code">
            <Input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]*"
              maxLength={7}
              required
              autoFocus
              placeholder="123456"
              className="w-full text-center font-mono text-lg tracking-[0.3em]"
            />
          </Field>
          {actionData.outcome.kind === "rejected" ? (
            <p role="alert" className="text-sm text-[var(--bo-failed)]">
              {actionData.outcome.error}
            </p>
          ) : actionData.outcome.kind === "resent" ? (
            <p role="status" className="text-sm text-[var(--bo-muted)]">
              We sent a new code. Use the most recent email.
            </p>
          ) : null}
          <Button
            type="submit"
            name="intent"
            value="verify_code"
            variant="solid"
            disabled={pending}
            className="w-full"
          >
            {pending && submittedIntent === "verify_code" ? "Checking…" : "Continue"}
          </Button>
        </Form>
        <div className="mt-6 space-y-3 border-t border-[var(--bo-border)] pt-4 text-sm text-[var(--bo-muted)]">
          <p>Didn't get it? Check your spam or promotions folder.</p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Form method="post">
              <input type="hidden" name="email" value={actionData.email} />
              <Button
                type="submit"
                name="intent"
                value="resend_code"
                variant="ghost"
                disabled={pending || resendIn > 0}
                className="px-0"
              >
                {resendIn > 0 ? `Send a new code in ${resendIn}s` : "Send a new code"}
              </Button>
            </Form>
            {/* Loading the page again starts over with the request the app sent. */}
            <Link
              to={{ search: location.search }}
              className="text-[var(--bo-accent)] underline-offset-4 hover:underline"
            >
              Use a different email
            </Link>
          </div>
        </div>
      </AppAuthLayout>
    );
  }

  if (actionData?.step === "method") {
    return (
      <AppAuthLayout
        brand={brand}
        title={`Continue to ${branding.displayName}`}
        description={
          <>
            As <strong className="text-[var(--bo-fg)]">{actionData.email}</strong>.{" "}
            {/* Loading the page again starts over with the request the app sent. */}
            <Link
              to={{ search: location.search }}
              className="text-[var(--bo-accent)] underline-offset-4 hover:underline"
            >
              Use a different email
            </Link>
          </>
        }
      >
        <div className="space-y-4">
          {actionData.error === null ? null : (
            <p role="alert" className="text-sm text-[var(--bo-failed)]">
              {actionData.error}
            </p>
          )}
          <Form method="post" className="space-y-2">
            <input type="hidden" name="email" value={actionData.email} />
            <Button
              type="submit"
              name="intent"
              value="send_code"
              variant="solid"
              disabled={pending}
              className="w-full"
            >
              {pending && submittedIntent === "send_code"
                ? "Sending your code…"
                : "Email me a code"}
            </Button>
            <p className="text-xs leading-5 text-[var(--bo-muted)]">
              New here? The code creates your account.
            </p>
          </Form>
          <Divider label="Or use your password" />
          <Form method="post" className="space-y-4">
            {/* Lets password managers pair the password with this address. */}
            <input type="hidden" name="email" value={actionData.email} autoComplete="username" />
            <Field label="Password">
              <Input
                type="password"
                name="password"
                autoComplete="current-password"
                required
                className="w-full"
              />
            </Field>
            <Button
              type="submit"
              name="intent"
              value="sign_in_password"
              variant="secondary"
              disabled={pending}
              className="w-full"
            >
              {pending && submittedIntent === "sign_in_password" ? "Signing in…" : "Sign in"}
            </Button>
          </Form>
        </div>
      </AppAuthLayout>
    );
  }

  return (
    <AppAuthLayout
      brand={brand}
      title={`Continue to ${branding.displayName}`}
      description="Enter your email to sign in. New here? This creates your account."
    >
      <div className="space-y-4">
        <Form method="post" className="space-y-4">
          <Field label="Email">
            <Input
              type="email"
              name="email"
              autoComplete="username"
              required
              autoFocus
              defaultValue={actionData?.email ?? page.loginHint ?? ""}
              placeholder="you@example.com"
              className="w-full"
            />
          </Field>
          {actionData?.step === "email" ? (
            <p role="alert" className="text-sm text-[var(--bo-failed)]">
              {actionData.error}
            </p>
          ) : null}
          <Button
            type="submit"
            name="intent"
            value="choose_method"
            variant="solid"
            disabled={pending || githubPending}
            className="w-full"
          >
            Next
          </Button>
        </Form>
        <Divider label="Or" />
        <Button
          variant="secondary"
          onClick={() => void continueWithGitHub()}
          disabled={pending || githubPending}
          className="w-full"
        >
          {githubPending ? "Redirecting…" : "Continue with GitHub"}
        </Button>
        {githubError === null ? null : (
          <p role="alert" className="text-sm text-[var(--bo-failed)]">
            {githubError}
          </p>
        )}
      </div>
    </AppAuthLayout>
  );
}

function Divider({ label }: { label: string }) {
  return (
    <div role="separator" className="flex items-center gap-3 text-xs text-[var(--bo-muted)]">
      <span className="h-px flex-1 bg-[var(--bo-border)]" aria-hidden="true" />
      <span>{label}</span>
      <span className="h-px flex-1 bg-[var(--bo-border)]" aria-hidden="true" />
    </div>
  );
}
