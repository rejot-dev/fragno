import "../../backoffice.css";

import { useEffect, useRef } from "react";
import { Form, Link, useActionData, useFetcher, useLoaderData, useNavigation } from "react-router";
import { z } from "zod";

import { FormContainer, FormField } from "@/components/backoffice";
import { requestEmailVerificationResend } from "@/fragno/auth/email-verification.server";
import { getSystemOtpDurableObject } from "@/worker-runtime/durable-objects";

import type { Route } from "./+types/verify-email";

const verificationInputSchema = z.object({
  userId: z.string().trim().min(1),
  code: z.string().trim().min(1),
});

const verificationActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("confirm"),
    userId: z.string().trim().min(1),
    code: z.string().trim().min(1),
  }),
  z.object({
    intent: z.literal("resend"),
    email: z.string().trim().toLowerCase().pipe(z.email().max(191)),
  }),
]);

const verificationResultSchema = z.enum([
  "confirmation_recorded",
  "already_confirmed",
  "expired",
  "invalid",
  "incomplete",
  "resent",
  "resend_failed",
]);

type VerificationPageData =
  | {
      state: "ready";
      userId: string;
      code: string;
    }
  | {
      state: "result";
      result: z.infer<typeof verificationResultSchema>;
    };

type VerificationActionData = Extract<VerificationPageData, { state: "result" }>;

export function loader({ url }: Route.LoaderArgs): VerificationPageData {
  const input = verificationInputSchema.safeParse({
    userId: url.searchParams.get("userId"),
    code: url.searchParams.get("code"),
  });
  if (!input.success) {
    return { state: "result", result: "incomplete" };
  }

  return {
    state: "ready",
    userId: input.data.userId,
    code: input.data.code,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const formData = await request.formData();
  const input = verificationActionSchema.safeParse(Object.fromEntries(formData));
  if (!input.success) {
    return { state: "result", result: "incomplete" };
  }

  if (input.data.intent === "resend") {
    const resend = await requestEmailVerificationResend({
      request,
      context,
      email: input.data.email,
    });
    return {
      state: "result",
      result: resend.status === "accepted" ? "resent" : "resend_failed",
    } satisfies VerificationActionData;
  }

  const confirmation = await getSystemOtpDurableObject(
    context,
  ).commands.confirmEmailVerificationChallenge({
    userId: input.data.userId,
    code: input.data.code,
  });
  if (confirmation.status === "confirmation_recorded") {
    return {
      state: "result",
      result: "confirmation_recorded",
    } satisfies VerificationActionData;
  }
  if (confirmation.status === "already_confirmed") {
    return { state: "result", result: "already_confirmed" } satisfies VerificationActionData;
  }

  return {
    state: "result",
    result: confirmation.reason === "expired" ? "expired" : "invalid",
  } satisfies VerificationActionData;
}

export function meta() {
  return [
    { title: "Verify your Backoffice email" },
    { name: "description", content: "Confirm the email address for your Backoffice account." },
  ];
}

const resultContent = {
  confirmation_recorded: {
    eyebrow: "Email verified",
    title: "Your email is verified.",
    description: "Continue to sign in to Backoffice.",
  },
  already_confirmed: {
    eyebrow: "Already confirmed",
    title: "This email was already verified.",
    description: "This verification link was already submitted. Continue to sign in.",
  },
  expired: {
    eyebrow: "Link expired",
    title: "This verification link has expired.",
    description: "The link is no longer active. Request a new verification email to continue.",
  },
  invalid: {
    eyebrow: "Link unavailable",
    title: "This verification link is invalid.",
    description: "The link may have already been replaced. Use the latest verification email.",
  },
  incomplete: {
    eyebrow: "Link incomplete",
    title: "This verification link is incomplete.",
    description: "Open the complete link from your Backoffice verification email.",
  },
  resent: {
    eyebrow: "Request accepted",
    title: "Check your email.",
    description: "If this unverified account exists, a new email will be sent.",
  },
  resend_failed: {
    eyebrow: "Request unavailable",
    title: "We could not request another email.",
    description: "Check the email address and try again.",
  },
} satisfies Record<
  z.infer<typeof verificationResultSchema>,
  { eyebrow: string; title: string; description: string }
>;

export default function VerifyEmail() {
  const loaderData = useLoaderData<VerificationPageData>();
  const actionData = useActionData<VerificationActionData>();
  const navigation = useNavigation();
  const confirmation = useFetcher<VerificationActionData>();
  const automaticConfirmationStarted = useRef(false);
  const confirmationData = confirmation.data;
  const confirmationPending = confirmation.state !== "idle";
  const routeSubmissionPending = navigation.state === "submitting";
  const data: VerificationPageData = confirmationData ?? actionData ?? loaderData;

  useEffect(() => {
    if (loaderData.state !== "ready" || automaticConfirmationStarted.current) {
      return;
    }

    automaticConfirmationStarted.current = true;
    void confirmation.submit(
      {
        intent: "confirm",
        userId: loaderData.userId,
        code: loaderData.code,
      },
      { method: "post", action: "/backoffice/verify-email" },
    );
  }, [confirmation, loaderData]);

  const content =
    data.state === "ready"
      ? {
          eyebrow: "Verification in progress",
          title: "Verifying your email.",
          description: "Keep this page open while we confirm your email address.",
        }
      : resultContent[data.result];

  return (
    <div
      data-backoffice-root
      className="relative isolate min-h-screen bg-[var(--bo-bg)] text-[var(--bo-fg)]"
    >
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(0deg,rgba(var(--bo-overlay),0.96),rgba(var(--bo-overlay),0.96)),linear-gradient(90deg,rgba(var(--bo-grid),0.45)_1px,transparent_1px),linear-gradient(0deg,rgba(var(--bo-grid),0.45)_1px,transparent_1px)] bg-[size:100%_100%,28px_28px,28px_28px]" />
      <main className="relative mx-auto flex min-h-screen w-full max-w-xl items-center px-4 py-10">
        <div className="w-full">
          <FormContainer
            eyebrow={content.eyebrow}
            title={content.title}
            description={content.description}
          >
            {data.state === "ready" ? (
              <confirmation.Form
                method="post"
                action="/backoffice/verify-email"
                className="space-y-4"
              >
                <input type="hidden" name="intent" value="confirm" />
                <input type="hidden" name="userId" value={data.userId} />
                <input type="hidden" name="code" value={data.code} />
                <p className="text-sm leading-6 text-[var(--bo-muted)]" aria-live="polite">
                  {confirmationPending
                    ? "Confirming your email…"
                    : "Verification starts automatically. If it does not, continue below."}
                </p>
                <button
                  type="submit"
                  disabled={confirmationPending}
                  className="min-h-10 border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-transform active:scale-[0.96] disabled:opacity-60"
                >
                  {confirmationPending ? "Verifying…" : "Verify now"}
                </button>
              </confirmation.Form>
            ) : (
              <div className="space-y-4">
                {data.result !== "confirmation_recorded" && data.result !== "already_confirmed" ? (
                  <Form method="post" action="/backoffice/verify-email" className="space-y-3">
                    <input type="hidden" name="intent" value="resend" />
                    <FormField
                      label="Email address"
                      hint="Enter the address used for this account."
                    >
                      <input
                        type="email"
                        name="email"
                        autoComplete="email"
                        required
                        className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
                      />
                    </FormField>
                    <button
                      type="submit"
                      disabled={routeSubmissionPending}
                      className="min-h-10 border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-transform active:scale-[0.96] disabled:opacity-60"
                    >
                      {routeSubmissionPending ? "Requesting…" : "Send a new verification email"}
                    </button>
                  </Form>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Link
                    to="/backoffice/login"
                    className="inline-flex min-h-10 items-center border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-transform active:scale-[0.96]"
                  >
                    Continue to sign in
                  </Link>
                </div>
              </div>
            )}
          </FormContainer>
        </div>
      </main>
    </div>
  );
}
