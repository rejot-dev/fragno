import { assert, describe, expect, test, vi } from "vitest";

import { RouterContextProvider } from "react-router";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  class MockRpcTarget {}
  class MockWorkerEntrypoint {}

  return {
    DurableObject: MockDurableObject,
    RpcTarget: MockRpcTarget,
    WorkerEntrypoint: MockWorkerEntrypoint,
  };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import type { DurableUserEmailVerifiedHookPayload } from "@fragno-dev/auth";

import { EMAIL_VERIFICATION_TYPE } from "@/fragno/otp";
import {
  action as submitEmailVerificationAction,
  loader as loadEmailVerification,
} from "@/routes/backoffice/verify-email";
import { getSetCookieHeaders } from "@/worker-runtime/http-headers";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
  type BackofficeScenarioStep,
} from "./scenario";

const getEmailVerificationRequestedHook = async (ctx: BackofficeScenarioContext) => {
  const repository = await ctx.runtime.objects.auth.singleton().getDurableHookRepository();
  const queue = await repository.getHookQueue({ pageSize: 100 });
  const hook = queue.items.find((item) => item.hookName === "onUserEmailVerificationRequested");
  assert(hook, "Expected Auth onUserEmailVerificationRequested hook to exist.");
  return hook;
};

const getOtpIssuedHook = async (ctx: BackofficeScenarioContext) => {
  const repository = await ctx.runtime.objects.otp.singleton().getDurableHookRepository();
  const queue = await repository.getHookQueue({ pageSize: 100 });
  const hook = queue.items.find((item) => item.hookName === "onOtpIssued");
  assert(hook, "Expected OTP onOtpIssued hook to exist.");
  return hook;
};

const getQueuedEmailVerificationUrl = (ctx: BackofficeScenarioContext, index = 0): URL => {
  const emailText = ctx.fakes.resend?.queueEmailCalls[index]?.input.text;
  assert(emailText, `Expected queued verification email ${index + 1}.`);
  const verificationUrl = emailText.split("\n").find((line) => line.startsWith("https://"));
  assert(verificationUrl, "Expected the email to contain a verification URL.");
  return new URL(verificationUrl);
};

const requestEmailVerificationResend = (
  ctx: BackofficeScenarioContext,
  email: string,
): Promise<Response> =>
  ctx.runtime.objects.auth.singleton().fetch(
    new Request("https://backoffice.example/api/auth/email-verification/resend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    }),
  );

const requestEmailVerificationResendFromPage = async (
  ctx: BackofficeScenarioContext,
  email: string,
) => {
  const context = createScenarioRouterContext(ctx);
  return await submitEmailVerificationAction({
    request: new Request("https://backoffice.example/backoffice/verify-email", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({ intent: "resend", email }),
    }),
    context,
    params: {},
  } as unknown as Parameters<typeof submitEmailVerificationAction>[0]);
};

const buildCookieHeader = (setCookieHeaders: string[]): string =>
  setCookieHeaders.map((header) => header.split(";", 1)[0]).join("; ");

const submitEmailVerificationUrl = async (ctx: BackofficeScenarioContext, verificationUrl: URL) => {
  const context = createScenarioRouterContext(ctx);
  const page = loadEmailVerification({
    request: new Request(verificationUrl),
    url: verificationUrl,
    context,
    params: {},
  } as unknown as Parameters<typeof loadEmailVerification>[0]);
  assert(page.state === "ready");

  const result = await submitEmailVerificationAction({
    request: new Request(new URL("/backoffice/verify-email.data", verificationUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({
        intent: "confirm",
        userId: page.userId,
        code: page.code,
      }),
    }),
    context,
    params: {},
  } as unknown as Parameters<typeof submitEmailVerificationAction>[0]);

  if (!(result instanceof Response)) {
    return { data: result, cookie: "", setCookieHeaders: [] };
  }

  const setCookieHeaders = getSetCookieHeaders(result.headers);
  return {
    data: (await result.json()) as { state: "result"; result: string },
    cookie: buildCookieHeader(setCookieHeaders),
    setCookieHeaders,
  };
};

const completeEmailVerificationLogin = async (ctx: BackofficeScenarioContext, cookie: string) => {
  const context = createScenarioRouterContext(ctx);
  const response = await submitEmailVerificationAction({
    request: new Request("https://backoffice.example/backoffice/verify-email.data", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        cookie,
      },
      body: new URLSearchParams({ intent: "complete_login" }),
    }),
    context,
    params: {},
  } as unknown as Parameters<typeof submitEmailVerificationAction>[0]);
  assert(response instanceof Response);

  return {
    data: (await response.json()) as { state: "login"; status: string },
    cookie: buildCookieHeader(getSetCookieHeaders(response.headers)),
  };
};

const signInWithPassword = (ctx: BackofficeScenarioContext, email: string) =>
  ctx.runtime.objects.auth.singleton().fetch(
    new Request("https://backoffice.example/api/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    }),
  );

const createScenarioRouterContext = (ctx: BackofficeScenarioContext) => {
  const routerContext = new RouterContextProvider();
  routerContext.set(BackofficeWorkerContext, {
    runtime: ctx.runtime.services,
    env: ctx.runtime.env as unknown as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
  return routerContext;
};

const issuePublicEmailVerificationOtp = (): BackofficeScenarioStep => ({
  kind: "when",
  type: "otp.issuePublicEmailVerificationOtp",
  label: "issue an email verification OTP through the public organization route",
  async run(ctx) {
    const response = await ctx.runtime.objects.otp.forOrg("attacker-org").fetch(
      new Request("https://backoffice.example/api/otp/otp/issue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          externalId: "target-user",
          type: EMAIL_VERIFICATION_TYPE,
          durationMinutes: 60,
          payload: {
            email: "target@example.com",
            publicBaseUrl: "https://attacker.example",
            expiresInHours: 1,
          },
        }),
      }),
    );
    assert.equal(response.status, 403);
  },
});

describe("Auth email verification scenarios", () => {
  test("sign-up queues and confirms the email verification link", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "auth sign-up queues and confirms the email verification link",
        env: { AUTH_EMAIL_VERIFICATION_ENABLED: "true" },
        fakes: ({ fake }) => ({ resend: fake.resend() }),
        steps: ({ when, then }) => [
          when.auth.signUp({ email: "new-user@example.com" }),
          then.resend.queuedEmail({
            to: "new-user@example.com",
            subject: "Verify your email for Fragno Backoffice",
            text: /\/backoffice\/verify-email\?userId=[^&]+&code=[A-Z0-9]+/u,
            idempotencyKey: /^auth:email-verification:[^:]+$/u,
          }),
          then.assert("unverified user cannot sign in", async (ctx) => {
            const response = await signInWithPassword(ctx, "new-user@example.com");
            assert.equal(response.status, 403);
            const body = (await response.json()) as { code?: string };
            assert.equal(body.code, "email_verification_required");
          }),
          {
            kind: "when",
            type: "auth.confirmQueuedSignUpEmail",
            label: "open and submit the queued signup verification link",
            async run(ctx) {
              const verificationUrl = getQueuedEmailVerificationUrl(ctx);
              const confirmation = await submitEmailVerificationUrl(ctx, verificationUrl);
              expect(confirmation.data).toEqual({
                state: "result",
                result: "confirmation_recorded",
              });
              assert(confirmation.cookie);
              expect(confirmation.setCookieHeaders).toEqual([
                expect.stringContaining("Path=/backoffice;"),
              ]);

              const pendingLogin = await completeEmailVerificationLogin(ctx, confirmation.cookie);
              expect(pendingLogin.data).toEqual({ state: "login", status: "pending" });

              await ctx.runtime.drain();
              const authenticatedLogin = await completeEmailVerificationLogin(
                ctx,
                confirmation.cookie,
              );
              expect(authenticatedLogin.data).toEqual({
                state: "login",
                status: "authenticated",
              });
              assert(authenticatedLogin.cookie);

              const meResponse = await ctx.runtime.objects.auth.singleton().fetch(
                new Request("https://backoffice.example/api/auth/me", {
                  headers: { cookie: authenticatedLogin.cookie },
                }),
              );
              assert(meResponse.ok);

              const context = createScenarioRouterContext(ctx);
              const actionUrl = new URL("/backoffice/verify-email", verificationUrl);
              expect(
                loadEmailVerification({
                  request: new Request(actionUrl),
                  url: actionUrl,
                  context,
                  params: {},
                } as unknown as Parameters<typeof loadEmailVerification>[0]),
              ).toEqual({ state: "result", result: "incomplete" });
            },
          },
          then.assert("verified user can sign in", async (ctx) => {
            const response = await signInWithPassword(ctx, "new-user@example.com");
            assert(response.ok);
          }),
          then.assert("verification route marks the Auth email as verified", async (ctx) => {
            const userId = getQueuedEmailVerificationUrl(ctx).searchParams.get("userId");
            assert(userId);

            const repository = await ctx.runtime.objects.auth
              .singleton()
              .getDurableHookRepository();
            const queue = await repository.getHookQueue({ pageSize: 100 });
            const verificationHook = queue.items.find(
              (hook) => hook.hookName === "onUserEmailVerified",
            );
            assert(verificationHook);
            const payload = verificationHook.payload as DurableUserEmailVerifiedHookPayload;
            expect(payload).toMatchObject({
              user: { id: userId, email: "new-user@example.com" },
              actor: null,
            });
          }),
        ],
      }),
    );
  });

  test("resend supersedes the previous challenge and only the latest link verifies", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "auth verification resend supersedes the previous challenge",
        env: { AUTH_EMAIL_VERIFICATION_ENABLED: "true" },
        fakes: ({ fake }) => ({ resend: fake.resend() }),
        steps: ({ when, then }) => [
          when.auth.signUp({ email: "resend-user@example.com" }),
          then.assert("resend creates a fresh challenge", async (ctx) => {
            const firstUrl = getQueuedEmailVerificationUrl(ctx);
            ctx.runtime.advanceTime(61_000);
            const resendResponse = await requestEmailVerificationResend(
              ctx,
              "resend-user@example.com",
            );
            assert.equal(resendResponse.status, 202);
            expect(await resendResponse.json()).toEqual({ accepted: true });
            await ctx.runtime.drain();

            expect(ctx.fakes.resend?.queueEmailCalls).toHaveLength(2);
            const secondUrl = getQueuedEmailVerificationUrl(ctx, 1);
            expect(secondUrl.searchParams.get("code")).not.toBe(firstUrl.searchParams.get("code"));
            assert(
              new Set(ctx.fakes.resend?.queueEmailCalls.map((call) => call.options.idempotencyKey))
                .size === 2,
            );

            expect((await submitEmailVerificationUrl(ctx, firstUrl)).data).toEqual({
              state: "result",
              result: "invalid",
            });
            expect((await submitEmailVerificationUrl(ctx, secondUrl)).data).toEqual({
              state: "result",
              result: "confirmation_recorded",
            });
            await ctx.runtime.drain();
            assert((await signInWithPassword(ctx, "resend-user@example.com")).ok);
          }),
        ],
      }),
    );
  });

  test("an expired link can be replaced through self-service resend", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "auth expired verification link recovers through resend",
        env: { AUTH_EMAIL_VERIFICATION_ENABLED: "true" },
        fakes: ({ fake }) => ({ resend: fake.resend() }),
        steps: ({ when, then }) => [
          when.auth.signUp({ email: "expired-user@example.com" }),
          then.assert("expired link is replaced and the user can sign in", async (ctx) => {
            const expiredUrl = getQueuedEmailVerificationUrl(ctx);
            const elapsedMs = 24 * 60 * 60 * 1_000 + 1;
            ctx.runtime.advanceTime(elapsedMs);

            expect((await submitEmailVerificationUrl(ctx, expiredUrl)).data).toEqual({
              state: "result",
              result: "expired",
            });

            const resendResult = await requestEmailVerificationResendFromPage(
              ctx,
              "expired-user@example.com",
            );
            expect(resendResult).toEqual({ state: "result", result: "resent" });
            await ctx.runtime.drain();

            const replacementUrl = getQueuedEmailVerificationUrl(ctx, 1);
            expect((await submitEmailVerificationUrl(ctx, replacementUrl)).data).toEqual({
              state: "result",
              result: "confirmation_recorded",
            });
            await ctx.runtime.drain();
            assert((await signInWithPassword(ctx, "expired-user@example.com")).ok);
          }),
        ],
      }),
    );
  });

  test("resend returns the generic accepted response for an unknown email", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "auth verification resend resists account enumeration",
        env: { AUTH_EMAIL_VERIFICATION_ENABLED: "true" },
        fakes: ({ fake }) => ({ resend: fake.resend() }),
        steps: ({ then }) => [
          then.assert("unknown account is accepted without delivery", async (ctx) => {
            const response = await requestEmailVerificationResend(ctx, "missing@example.com");
            assert.equal(response.status, 202);
            expect(await response.json()).toEqual({ accepted: true });
            await ctx.runtime.drain();
            expect(ctx.fakes.resend?.queueEmailCalls).toHaveLength(0);
          }),
        ],
      }),
    );
  });

  test("signup remains committed while Auth retries an unconfigured Resend", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "Auth email delivery retries when singleton Resend is unconfigured",
        env: { AUTH_EMAIL_VERIFICATION_ENABLED: "true" },
        steps: ({ when, then }) => [
          when.auth.signUp({ email: "new-user@example.com" }),
          then.assert("Auth owns the retryable email delivery", async (ctx) => {
            const resendConfig = await ctx.runtime.objects.resend.singleton().getAdminConfig();
            assert(!resendConfig.configured);
            assert(
              ctx.runtime.hasObjectInstance({
                binding: "OTP",
                scope: { kind: "singleton" },
              }),
            );

            const authHook = await getEmailVerificationRequestedHook(ctx);
            assert.equal(authHook.status, "pending");
            assert.equal(authHook.attempts, 1);
            assert(authHook.nextRetryAt);
            assert.match(authHook.error ?? "", /Resend is not configured for email delivery/u);

            const otpHook = await getOtpIssuedHook(ctx);
            assert.equal(otpHook.status, "completed");

            const signInResponse = await signInWithPassword(ctx, "new-user@example.com");
            assert.equal(signInResponse.status, 403);
          }),
        ],
      }),
    );
  });

  test("public organization OTP issuance cannot send signup verification email", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "public OTP issuance has no auth email delivery side effect",
        env: { AUTH_EMAIL_VERIFICATION_ENABLED: "true" },
        fakes: ({ fake }) => ({ resend: fake.resend() }),
        steps: ({ then }) => [
          issuePublicEmailVerificationOtp(),
          then.resend.noQueuedEmails(),
          then.assert("public OTP issuance creates no durable email challenge", async (ctx) => {
            const repository = await ctx.runtime.objects.otp
              .forOrg("attacker-org")
              .getDurableHookRepository();
            const queue = await repository.getHookQueue({ pageSize: 100 });
            assert(!queue.items.some((hook) => hook.hookName === "onOtpIssued"));
          }),
        ],
      }),
    );
  });

  test("sign-up authenticates immediately when email verification is disabled", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "auth sign-up skips verification delivery when disabled",
        fakes: ({ fake }) => ({ resend: fake.resend() }),
        steps: ({ when, then }) => [
          when.auth.signUp({ email: "new-user@example.com" }),
          then.resend.noQueuedEmails(),
          then.assert("disabled verification authenticates without issuing an OTP", async (ctx) => {
            assert(
              !ctx.runtime.hasObjectInstance({
                binding: "OTP",
                scope: { kind: "singleton" },
              }),
            );
            const response = await signInWithPassword(ctx, "new-user@example.com");
            assert(response.ok);
          }),
        ],
      }),
    );
  });
});
