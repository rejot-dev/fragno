import "@fragno-private/design-system/components.css";

import { Button, ButtonLink } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { FormContainer } from "@fragno-private/design-system/form-container";
import { Input } from "@fragno-private/design-system/input";
import { data, Form, redirect, useNavigation } from "react-router";
import { z } from "zod";

import { callBetterAuth, createBackofficeIdentityChangeHeaders } from "@/fragno/auth/auth-server";
import {
  BACKOFFICE_PASSWORD_MIN_LENGTH,
  BACKOFFICE_PASSWORD_MAX_LENGTH,
} from "@/fragno/auth/password-policy";

import type { Route } from "./+types/reset-password";

const resetPasswordSchema = z
  .object({
    token: z.string().min(1).max(256),
    newPassword: z
      .string()
      .min(
        BACKOFFICE_PASSWORD_MIN_LENGTH,
        `Use at least ${BACKOFFICE_PASSWORD_MIN_LENGTH} characters.`,
      )
      .max(
        BACKOFFICE_PASSWORD_MAX_LENGTH,
        `Use no more than ${BACKOFFICE_PASSWORD_MAX_LENGTH} characters.`,
      ),
    confirmPassword: z.string(),
  })
  .refine((input) => input.newPassword === input.confirmPassword, {
    message: "The passwords do not match.",
    path: ["confirmPassword"],
  });

export function headers() {
  return { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
}

export function loader({ url }: Route.LoaderArgs) {
  const token = z.string().min(1).max(256).safeParse(url.searchParams.get("token"));
  // Loading the page never consumes the link: mail scanners may open it before the user does.
  return data(
    token.success && !url.searchParams.has("error")
      ? { state: "ready" as const, token: token.data }
      : { state: "invalid" as const },
    { headers: headers() },
  );
}

export async function action({ request, context }: Route.ActionArgs) {
  const formData = Object.fromEntries(await request.formData());
  if (!z.string().min(1).max(256).safeParse(formData.token).success) {
    return data({ state: "invalid" as const }, { status: 400, headers: headers() });
  }
  const input = resetPasswordSchema.safeParse(formData);
  if (!input.success) {
    return data(
      { state: "error" as const, message: input.error.issues[0].message },
      { status: 400, headers: headers() },
    );
  }

  try {
    const response = await callBetterAuth(request, context, "/reset-password", {
      method: "POST",
      body: JSON.stringify({ token: input.data.token, newPassword: input.data.newPassword }),
    });
    if (response.ok) {
      const responseHeaders = createBackofficeIdentityChangeHeaders(response);
      responseHeaders.set("Cache-Control", "no-store");
      responseHeaders.set("Referrer-Policy", "no-referrer");
      return redirect("/backoffice/login?passwordReset=success", { headers: responseHeaders });
    }
    if (response.status === 400) {
      const error = (await response.json()) as { code: string };
      if (error.code === "INVALID_TOKEN" || error.code === "USER_NOT_FOUND") {
        return data({ state: "invalid" as const }, { status: 400, headers: headers() });
      }
    }
    return data(
      {
        state: "error" as const,
        message:
          response.status === 429
            ? "Too many requests. Wait a minute before trying again."
            : "We could not reset your password. Please try again.",
      },
      { status: response.status === 429 ? 429 : 503, headers: headers() },
    );
  } catch {
    return data(
      { state: "error" as const, message: "We could not reset your password. Please try again." },
      { status: 503, headers: headers() },
    );
  }
}

export function meta() {
  return [
    { title: "Choose a new Backoffice password" },
    { name: "robots", content: "noindex, nofollow" },
    { name: "referrer", content: "no-referrer" },
  ];
}

export default function ResetPassword({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const pending = navigation.state !== "idle";
  const invalid = loaderData.state === "invalid" || actionData?.state === "invalid";

  return (
    <div data-backoffice-root className="min-h-screen bg-[var(--bo-bg)] text-[var(--bo-fg)]">
      <main className="mx-auto flex min-h-screen w-full max-w-xl items-center px-4 py-10">
        <div className="w-full">
          <FormContainer
            title={invalid ? "This reset link is unavailable" : "Choose a new password"}
            description={
              invalid
                ? "The link may have expired or already been used. Request a new link to continue."
                : "After resetting your password, sign in again with your new password."
            }
          >
            <div className="space-y-4">
              {!invalid && loaderData.state === "ready" ? (
                <Form method="post" className="space-y-4">
                  <input type="hidden" name="token" value={loaderData.token} />
                  <Field
                    label="New password"
                    description={`Use ${BACKOFFICE_PASSWORD_MIN_LENGTH}–${BACKOFFICE_PASSWORD_MAX_LENGTH} characters.`}
                  >
                    <Input
                      type="password"
                      name="newPassword"
                      autoComplete="new-password"
                      minLength={BACKOFFICE_PASSWORD_MIN_LENGTH}
                      maxLength={BACKOFFICE_PASSWORD_MAX_LENGTH}
                      required
                      className="w-full"
                    />
                  </Field>
                  <Field label="Confirm new password">
                    <Input
                      type="password"
                      name="confirmPassword"
                      autoComplete="new-password"
                      minLength={BACKOFFICE_PASSWORD_MIN_LENGTH}
                      maxLength={BACKOFFICE_PASSWORD_MAX_LENGTH}
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
                    {pending ? "Resetting…" : "Reset password"}
                  </Button>
                </Form>
              ) : (
                <ButtonLink variant="accent" to="/backoffice/forgot-password">
                  Request a new reset link
                </ButtonLink>
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
