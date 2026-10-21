import "@fragno-private/design-system/components.css";

import { Button, ButtonLink } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { FormContainer } from "@fragno-private/design-system/form-container";
import { Input } from "@fragno-private/design-system/input";
import { data, Form, useNavigation } from "react-router";
import { z } from "zod";

import { callBetterAuth } from "@/fragno/auth/auth-server";

import type { Route } from "./+types/forgot-password";

const resetRequestSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(191)),
});

export function headers() {
  return { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
}

export async function action({ request, context }: Route.ActionArgs) {
  const input = resetRequestSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!input.success) {
    return data(
      { state: "error" as const, message: "Enter a valid email address." },
      { status: 400, headers: headers() },
    );
  }

  try {
    const response = await callBetterAuth(request, context, "/request-password-reset", {
      method: "POST",
      body: JSON.stringify({ email: input.data.email, redirectTo: "/backoffice/reset-password" }),
    });
    if (response.ok) {
      return data({ state: "accepted" as const }, { headers: headers() });
    }
    return data(
      {
        state: "error" as const,
        message:
          response.status === 429
            ? "Too many requests. Wait a minute before trying again."
            : "We could not request a reset email. Please try again later.",
      },
      { status: response.status === 429 ? 429 : 503, headers: headers() },
    );
  } catch {
    return data(
      {
        state: "error" as const,
        message: "We could not request a reset email. Please try again later.",
      },
      { status: 503, headers: headers() },
    );
  }
}

export function meta() {
  return [
    { title: "Reset your Backoffice password" },
    { name: "robots", content: "noindex, nofollow" },
  ];
}

export default function ForgotPassword({ actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const pending = navigation.state !== "idle";
  const accepted = actionData?.state === "accepted";

  return (
    <div data-backoffice-root className="min-h-screen bg-[var(--bo-bg)] text-[var(--bo-fg)]">
      <main className="mx-auto flex min-h-screen w-full max-w-xl items-center px-4 py-10">
        <div className="w-full">
          <FormContainer
            title={accepted ? "Check your email" : "Forgot your password?"}
            description={
              accepted
                ? "If an account exists for this address, we’ll send you a link to choose a password."
                : "Enter your account’s email address and we’ll send you a link to choose a new password."
            }
          >
            <div className="space-y-4">
              {accepted ? (
                <p role="status" className="text-sm leading-6 text-[var(--bo-muted)]">
                  Check your inbox and spam folder.
                </p>
              ) : (
                <Form method="post" className="space-y-4">
                  <Field label="Email address">
                    <Input
                      type="email"
                      name="email"
                      autoComplete="email"
                      maxLength={191}
                      required
                      className="w-full"
                    />
                  </Field>
                  {actionData?.state === "error" ? (
                    <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                      {actionData.message}
                    </p>
                  ) : null}
                  <Button variant="accent" type="submit" disabled={pending} className="w-full">
                    {pending ? "Requesting…" : "Send reset link"}
                  </Button>
                </Form>
              )}
              <ButtonLink variant="secondary" to="/backoffice/login">
                Back to sign in
              </ButtonLink>
            </div>
          </FormContainer>
        </div>
      </main>
    </div>
  );
}
