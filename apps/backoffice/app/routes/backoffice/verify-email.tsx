import "../../backoffice.css";

import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import { z } from "zod";

import { FormContainer } from "@/components/backoffice";
import { getSystemOtpDurableObject } from "@/worker-runtime/durable-objects";

import type { Route } from "./+types/verify-email";

const verificationInputSchema = z.object({
  userId: z.string().trim().min(1),
  code: z.string().trim().min(1),
});

const verificationResultSchema = z.enum(["verified", "expired", "invalid", "incomplete"]);

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

export async function action({
  request,
  context,
}: Route.ActionArgs): Promise<VerificationActionData> {
  const formData = await request.formData();
  const input = verificationInputSchema.safeParse({
    userId: formData.get("userId"),
    code: formData.get("code"),
  });
  if (!input.success) {
    return { state: "result", result: "incomplete" };
  }

  const confirmation = await getSystemOtpDurableObject(context).confirmEmailVerification(
    input.data,
  );
  if (confirmation.ok) {
    return { state: "result", result: "verified" };
  }

  return {
    state: "result",
    result: confirmation.error === "OTP_EXPIRED" ? "expired" : "invalid",
  };
}

export function meta() {
  return [
    { title: "Verify your Fragno Backoffice email" },
    { name: "description", content: "Confirm the email address for your backoffice account." },
  ];
}

const resultContent = {
  verified: {
    eyebrow: "Confirmation received",
    title: "Your verification was accepted.",
    description: "The email confirmation is recorded and your account is ready to use.",
  },
  expired: {
    eyebrow: "Link expired",
    title: "This verification link has expired.",
    description: "The link is no longer active. You can still continue to your account.",
  },
  invalid: {
    eyebrow: "Link unavailable",
    title: "This verification link is invalid.",
    description: "The link may have already been replaced. Use the latest verification email.",
  },
  incomplete: {
    eyebrow: "Link incomplete",
    title: "This verification link is incomplete.",
    description: "Open the complete link from your Fragno Backoffice signup email.",
  },
} satisfies Record<
  z.infer<typeof verificationResultSchema>,
  { eyebrow: string; title: string; description: string }
>;

export default function VerifyEmail() {
  const loaderData = useLoaderData<VerificationPageData>();
  const actionData = useActionData<VerificationActionData>();
  const data = actionData ?? loaderData;
  const navigation = useNavigation();
  const confirmationPending = navigation.state === "submitting";
  const content =
    data.state === "ready"
      ? {
          eyebrow: "One final step",
          title: "Verify your email address.",
          description:
            "Confirm that you opened this link to finish setting up your Fragno Backoffice account.",
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
              <Form method="post" action="/backoffice/verify-email" className="space-y-4">
                <input type="hidden" name="userId" value={data.userId} />
                <input type="hidden" name="code" value={data.code} />
                <p className="text-sm leading-6 text-[var(--bo-muted)]">
                  Email scanners cannot complete this step automatically. Press the button below to
                  confirm the address yourself.
                </p>
                <button
                  type="submit"
                  disabled={confirmationPending}
                  className="min-h-10 border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-transform active:scale-[0.96] disabled:opacity-60"
                >
                  {confirmationPending ? "Verifying…" : "Verify email"}
                </button>
              </Form>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Link
                  to="/backoffice/login"
                  className="inline-flex min-h-10 items-center border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-transform active:scale-[0.96]"
                >
                  Continue to sign in
                </Link>
                <Link
                  to="/docs"
                  className="inline-flex min-h-10 items-center border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                >
                  Return to docs
                </Link>
              </div>
            )}
          </FormContainer>
        </div>
      </main>
    </div>
  );
}
