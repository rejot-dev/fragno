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
  action as confirmEmailVerification,
  loader as loadEmailVerification,
} from "@/routes/backoffice/verify-email";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
  type BackofficeScenarioStep,
} from "./scenario";

const getUserCreatedHook = async (ctx: BackofficeScenarioContext) => {
  const repository = await ctx.runtime.objects.auth.singleton().getDurableHookRepository();
  const queue = await repository.getHookQueue({ pageSize: 100 });
  const hook = queue.items.find((item) => item.hookName === "onUserCreated");
  assert(hook, "Expected Auth onUserCreated hook to exist.");
  return hook;
};

const getOtpIssuedHook = async (ctx: BackofficeScenarioContext) => {
  const repository = await ctx.runtime.objects.otp.singleton().getDurableHookRepository();
  const queue = await repository.getHookQueue({ pageSize: 100 });
  const hook = queue.items.find((item) => item.hookName === "onOtpIssued");
  assert(hook, "Expected OTP onOtpIssued hook to exist.");
  return hook;
};

const getQueuedEmailVerificationUrl = (ctx: BackofficeScenarioContext): URL => {
  const emailText = ctx.fakes.resend?.queueEmailCalls[0]?.input.text;
  assert(emailText, "Expected a queued signup verification email.");
  const verificationUrl = emailText.split("\n").find((line) => line.startsWith("https://"));
  assert(verificationUrl, "Expected the signup email to contain a verification URL.");
  return new URL(verificationUrl);
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

const confirmQueuedSignUpEmail = (): BackofficeScenarioStep => ({
  kind: "when",
  type: "auth.confirmQueuedSignUpEmail",
  label: "open and submit the queued signup verification link",
  async run(ctx) {
    const verificationUrl = getQueuedEmailVerificationUrl(ctx);
    const context = createScenarioRouterContext(ctx);
    const page = loadEmailVerification({
      request: new Request(verificationUrl),
      url: verificationUrl,
      context,
      params: {},
    } as unknown as Parameters<typeof loadEmailVerification>[0]);
    assert(page.state === "ready");

    const actionUrl = new URL("/backoffice/verify-email", verificationUrl);
    const result = await confirmEmailVerification({
      request: new Request(actionUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ userId: page.userId, code: page.code }),
      }),
      context,
      params: {},
    } as unknown as Parameters<typeof confirmEmailVerification>[0]);
    expect(result).toEqual({ state: "result", result: "verified" });

    expect(
      loadEmailVerification({
        request: new Request(actionUrl),
        url: actionUrl,
        context,
        params: {},
      } as unknown as Parameters<typeof loadEmailVerification>[0]),
    ).toEqual({ state: "result", result: "incomplete" });
  },
});

describe("Auth transactional email scenarios", () => {
  test("sign-up queues and confirms the email verification link", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "auth sign-up queues and confirms the email verification link",
        env: { TRANSACTIONAL_EMAILS_ENABLED: "true" },
        fakes: ({ fake }) => ({ resend: fake.resend() }),
        steps: ({ when, then }) => [
          when.auth.signUp({ email: "new-user@example.com" }),
          then.resend.queuedEmail({
            to: "new-user@example.com",
            subject: "Verify your email for Fragno Backoffice",
            text: /\/backoffice\/verify-email\?userId=[^&]+&code=[A-Z0-9]+/u,
            idempotencyKey: /^auth:user-created:[^:]+:[^:]+$/u,
          }),
          then.assert("unverified user cannot sign in", async (ctx) => {
            const response = await signInWithPassword(ctx, "new-user@example.com");
            assert.equal(response.status, 403);
            const body = (await response.json()) as { code?: string };
            assert.equal(body.code, "email_verification_required");
          }),
          confirmQueuedSignUpEmail(),
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

  test("signup remains committed while Auth retries an unconfigured Resend", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "Auth email delivery retries when singleton Resend is unconfigured",
        env: { TRANSACTIONAL_EMAILS_ENABLED: "true" },
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

            const authHook = await getUserCreatedHook(ctx);
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
        name: "public OTP issuance has no transactional email side effect",
        env: { TRANSACTIONAL_EMAILS_ENABLED: "true" },
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

  test("sign-up retries before issuing an OTP when the public base URL is missing", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "auth sign-up requires a public base URL for verification email",
        env: {
          TRANSACTIONAL_EMAILS_ENABLED: "true",
          DOCS_PUBLIC_BASE_URL: undefined,
        },
        fakes: ({ fake }) => ({ resend: fake.resend() }),
        steps: ({ when, then }) => [
          when.auth.signUp({ email: "new-user@example.com" }),
          then.resend.noQueuedEmails(),
          then.assert("signup email hook reports the missing public base URL", async (ctx) => {
            assert(
              !ctx.runtime.hasObjectInstance({
                binding: "OTP",
                scope: { kind: "singleton" },
              }),
            );
            const hook = await getUserCreatedHook(ctx);
            assert.equal(hook.status, "pending");
            assert.match(hook.error ?? "", /DOCS_PUBLIC_BASE_URL must be configured/u);
          }),
        ],
      }),
    );
  });

  test("sign-up does not queue email when transactional emails are disabled", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "auth sign-up skips transactional email when disabled",
        fakes: ({ fake }) => ({ resend: fake.resend() }),
        steps: ({ when, then }) => [
          when.auth.signUp({ email: "new-user@example.com" }),
          then.resend.noQueuedEmails(),
          then.assert("disabled email does not issue a singleton OTP", (ctx) => {
            assert(
              !ctx.runtime.hasObjectInstance({
                binding: "OTP",
                scope: { kind: "singleton" },
              }),
            );
          }),
        ],
      }),
    );
  });
});
