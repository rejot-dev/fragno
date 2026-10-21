import { assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
  type BackofficeScenarioStep,
} from "@/fragno/automation/scenario";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { InMemoryAuthObject } from "../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../workers/automations.do";
import { InMemoryOtpObject } from "../../../workers/otp.do";
import { InMemoryUploadObject } from "../../../workers/upload.do";
import { action as requestPasswordReset } from "./forgot-password";
import { action as resetPassword, loader as loadResetPassword } from "./reset-password";

const origin = "https://backoffice.example";
const publicOrigin = "https://public-backoffice.example";
const email = "password-recovery@example.test";
const newPassword = "my-new-backoffice-password";

const scenarioObjects = {
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  OTP: (input) => new InMemoryOtpObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

function routerContext(ctx: BackofficeScenarioContext, request: Request) {
  return createBackofficeRouterContextProvider(request, {
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    env: ctx.runtime.env as unknown as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
}

function signIn(ctx: BackofficeScenarioContext, password: string) {
  return ctx.runtime.objects.auth.singleton().http.fetch(
    new Request(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", "x-forwarded-for": "192.0.2.10" },
      body: JSON.stringify({ email, password }),
    }),
  );
}

function requestPasswordResetStep(): BackofficeScenarioStep {
  return {
    kind: "when",
    type: "auth.requestPasswordReset",
    label: "request a reset email from a different origin than the configured public URL",
    async run(ctx) {
      const request = new Request(`${origin}/backoffice/forgot-password`, {
        method: "POST",
        headers: { origin, "x-forwarded-for": "192.0.2.10" },
        body: new URLSearchParams({ email }),
      });
      const result = await requestPasswordReset({
        request,
        context: routerContext(ctx, request),
        params: {},
        pattern: "/backoffice/forgot-password",
        url: new URL(request.url),
      });
      expect(result.data).toEqual({ state: "accepted" });
    },
  };
}

function resetPasswordFromEmailStep(): BackofficeScenarioStep {
  return {
    kind: "when",
    type: "auth.resetPassword",
    label: "open the emailed link and submit a new password",
    async run(ctx) {
      const message = ctx.fakes.resend?.queueEmailCalls[0]?.input.text;
      assert(message);
      const link = message
        .split("\n")
        .find((line) => line.startsWith(`${publicOrigin}/backoffice/reset-password?`));
      assert(link, "Expected the delivered email to contain the reset link.");
      const url = new URL(link);
      const request = new Request(url);
      const page = loadResetPassword({
        request,
        context: routerContext(ctx, request),
        params: {},
        pattern: "/backoffice/reset-password",
        url,
      });
      assert(page.data.state === "ready");
      expect(page.init?.headers).toMatchObject({
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });

      const submission = new Request(url, {
        method: "POST",
        headers: { origin: publicOrigin, "x-forwarded-for": "192.0.2.10" },
        body: new URLSearchParams({
          token: page.data.token,
          newPassword,
          confirmPassword: newPassword,
        }),
      });
      const result = await resetPassword({
        request: submission,
        context: routerContext(ctx, submission),
        params: {},
        pattern: "/backoffice/reset-password",
        url,
      });
      assert(result instanceof Response);
      assert(result.status === 302);
      assert(result.headers.get("location") === "/backoffice/login?passwordReset=success");
      expect(result.headers.getSetCookie()).toEqual(
        expect.arrayContaining([
          expect.stringContaining("fragno-backoffice.access_token=; Path=/; Max-Age=0"),
        ]),
      );
    },
  };
}

test("password recovery delivers a reset link, changes the password, and revokes existing sessions", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "password recovery through public forms and durable email delivery",
      env: {
        AUTH_EMAIL_VERIFICATION_ENABLED: "false",
        SIGN_UP_INVITATIONS_ENABLED: "false",
        DOCS_PUBLIC_BASE_URL: publicOrigin,
      },
      fakes: ({ fake }) => ({ resend: fake.resend() }),
      vars: () => ({ session: "" }),
      steps: ({ when, then }) => [
        when.auth.signUp({ email, captureSessionCookieAs: "session" }),
        requestPasswordResetStep(),
        then.resend.queuedEmail({
          to: email,
          subject: "Reset your Backoffice password",
          text: /\/backoffice\/reset-password\?token=/u,
          idempotencyKey: /^auth:password-reset:/u,
        }),
        resetPasswordFromEmailStep(),
        then.assert(
          "only the new password signs in and the previous session is revoked",
          async (ctx) => {
            const previousSession = await ctx.runtime.objects.auth.singleton().http.fetch(
              new Request(`${origin}/api/auth/get-session`, {
                headers: { cookie: ctx.vars.session },
              }),
            );
            expect(await previousSession.json()).toBeNull();
            assert((await signIn(ctx, "password123")).status === 401);
            const signedIn = await signIn(ctx, newPassword);
            assert(signedIn.ok, await signedIn.clone().text());
            expect(await signedIn.json()).toMatchObject({ user: { email, emailVerified: false } });
            expect(ctx.fakes.resend?.queueEmailCalls).toHaveLength(1);
            const hooks = await ctx.runtime.objects.auth.singleton().commands.getDurableHookQueue();
            expect(
              hooks.items.find((hook) => hook.hookName === "onUserPasswordResetRequested"),
            ).toMatchObject({ status: "completed" });
          },
        ),
      ],
    }),
  );
});

test("password recovery adds a password to an account that has none", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "password recovery for a user without a credential account",
      env: {
        AUTH_EMAIL_VERIFICATION_ENABLED: "false",
        SIGN_UP_INVITATIONS_ENABLED: "false",
        DOCS_PUBLIC_BASE_URL: publicOrigin,
      },
      fakes: ({ fake }) => ({ resend: fake.resend() }),
      steps: ({ given, then }) => [
        // The fixture creates only the user row, like an account whose sign-in method was removed.
        given.auth.user({ id: "passwordless-user", email }),
        requestPasswordResetStep(),
        then.resend.queuedEmail({
          to: email,
          subject: "Reset your Backoffice password",
          text: /\/backoffice\/reset-password\?token=/u,
          idempotencyKey: /^auth:password-reset:/u,
        }),
        resetPasswordFromEmailStep(),
        then.assert("the chosen password signs in to the existing user", async (ctx) => {
          const signedIn = await signIn(ctx, newPassword);
          assert(signedIn.ok, await signedIn.clone().text());
          expect(await signedIn.json()).toMatchObject({ user: { id: "passwordless-user", email } });
        }),
      ],
    }),
  );
});
