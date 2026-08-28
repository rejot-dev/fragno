import { afterEach, assert, describe, expect, test, vi } from "vitest";

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

import type { HookContext } from "@fragno-dev/db";
import type { OtpConfirmedHookPayload } from "@fragno-dev/otp-fragment";

import { createInMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import {
  EMAIL_VERIFICATION_EXPIRY_HOURS,
  EMAIL_VERIFICATION_TYPE,
  IDENTITY_LINK_TYPE,
} from "@/fragno/otp";

import { handleEmailVerificationConfirmed, handleIdentityClaimConfirmed } from "./otp.do";

const runtimes: Array<Awaited<ReturnType<typeof createInMemoryBackofficeRuntime>>> = [];

const createRuntime = async (
  options: Parameters<typeof createInMemoryBackofficeRuntime>[0] = {},
) => {
  const runtime = await createInMemoryBackofficeRuntime(options);
  runtimes.push(runtime);
  return runtime;
};

const signUp = async (
  runtime: Awaited<ReturnType<typeof createInMemoryBackofficeRuntime>>,
  email: string,
) => {
  const response = await runtime.objects.auth.singleton().http.fetch(
    new Request("https://backoffice.example/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Test User", email, password: "password123" }),
    }),
  );
  assert(response.ok);
  const result = (await response.json()) as { user: { id: string } };
  return { userId: result.user.id };
};

const signIn = async (
  runtime: Awaited<ReturnType<typeof createInMemoryBackofficeRuntime>>,
  email: string,
) =>
  await runtime.objects.auth.singleton().http.fetch(
    new Request("https://backoffice.example/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    }),
  );

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.cleanup()));
});

describe("OTP identity claim completion", () => {
  test("binds the identity before notifying its workflow and safely retries notification", async () => {
    const callOrder: string[] = [];
    let notificationAttempts = 0;
    const bindExternalIdentity = vi.fn(async () => {
      callOrder.push("bind");
      return {
        status: "active" as const,
        outcome: "created" as const,
        bindingId: "telegram:chat:chat-1",
        userId: "user-1",
        version: 0,
      };
    });
    const triggerIngestEvent = vi.fn(async () => {
      callOrder.push("notify");
      notificationAttempts += 1;
      if (notificationAttempts === 1) {
        throw new Error("notification unavailable");
      }
      return { accepted: true as const };
    });
    const runtime = {
      objects: {
        automations: {
          for: () => ({ commands: { bindExternalIdentity, triggerIngestEvent } }),
        },
      },
    } as unknown as BackofficeRuntimeServices;
    const payload = {
      id: "otp-1",
      externalId: "chat-1",
      type: IDENTITY_LINK_TYPE,
      code: "ABC12345",
      confirmedAt: new Date("2026-07-31T10:00:00.000Z"),
      payload: {
        orgId: "org-1",
        actor: {
          scope: "external",
          source: "telegram",
          type: "chat",
          id: "chat-1",
        },
      },
      confirmationPayload: { subjectUserId: "user-1" },
    } satisfies OtpConfirmedHookPayload;
    const context = {
      hookId: { toString: () => "otp-hook-1" },
      capturePropagationContext: () => ({ traceId: "trace-1" }),
    } as unknown as HookContext;

    await expect(handleIdentityClaimConfirmed(runtime, payload, context)).rejects.toThrow(
      "notification unavailable",
    );
    await expect(handleIdentityClaimConfirmed(runtime, payload, context)).resolves.toBeUndefined();

    expect(callOrder).toEqual(["bind", "notify", "bind", "notify"]);
    expect(bindExternalIdentity).toHaveBeenNthCalledWith(
      1,
      {
        identity: payload.payload.actor,
        userId: "user-1",
        verifiedByClaimId: "otp-1",
      },
      expect.objectContaining({
        execution: expect.objectContaining({ scope: { kind: "org", orgId: "org-1" } }),
      }),
    );
    expect(bindExternalIdentity).toHaveBeenNthCalledWith(
      2,
      {
        identity: payload.payload.actor,
        userId: "user-1",
        verifiedByClaimId: "otp-1",
      },
      expect.any(Object),
    );
    expect(triggerIngestEvent).toHaveBeenCalledTimes(2);
  });

  test("does not notify the workflow when the accepted claim is now revoked", async () => {
    const bindExternalIdentity = vi.fn(async () => ({
      status: "revoked" as const,
      outcome: "unchanged" as const,
      bindingId: "telegram:chat:chat-1",
      userId: "user-1",
      version: 1,
    }));
    const triggerIngestEvent = vi.fn();
    const runtime = {
      objects: {
        automations: {
          for: () => ({ commands: { bindExternalIdentity, triggerIngestEvent } }),
        },
      },
    } as unknown as BackofficeRuntimeServices;
    const payload = {
      id: "otp-1",
      externalId: "chat-1",
      type: IDENTITY_LINK_TYPE,
      code: "ABC12345",
      confirmedAt: new Date("2026-07-31T10:00:00.000Z"),
      payload: {
        orgId: "org-1",
        actor: {
          scope: "external",
          source: "telegram",
          type: "chat",
          id: "chat-1",
        },
      },
      confirmationPayload: { subjectUserId: "user-1" },
    } satisfies OtpConfirmedHookPayload;
    const context = {
      hookId: { toString: () => "otp-hook-1" },
      capturePropagationContext: () => ({ traceId: "trace-1" }),
    } as unknown as HookContext;

    await expect(handleIdentityClaimConfirmed(runtime, payload, context)).resolves.toBeUndefined();

    expect(bindExternalIdentity).toHaveBeenCalledOnce();
    expect(triggerIngestEvent).not.toHaveBeenCalled();
  });
});

describe("OTP Durable Object email verification", () => {
  test("idempotently issues a singleton challenge and synchronously verifies the Auth email", async () => {
    const runtime = await createRuntime({ env: { AUTH_EMAIL_VERIFICATION_ENABLED: "true" } });
    const { userId } = await signUp(runtime, "new-user@example.com");
    assert((await signIn(runtime, "new-user@example.com")).status === 403);
    const otp = runtime.objects.otp.singleton();
    const input = {
      userId,
      email: "new-user@example.com",
      publicBaseUrl: "https://backoffice.example",
      requestId: "auth-email-verification-hook-1",
    };

    const first = await otp.commands.issueEmailVerification(input);
    const repeated = await otp.commands.issueEmailVerification(input);

    expect(repeated).toEqual(first);
    assert(first.deliverable);
    expect(first.expiresInHours).toBe(EMAIL_VERIFICATION_EXPIRY_HOURS);
    await expect(
      otp.commands.issueEmailVerification({ ...input, email: "different@example.com" }),
    ).rejects.toThrow("request id cannot be reused with different delivery input");
    const verificationUrl = new URL(first.url);
    assert(verificationUrl.pathname === "/backoffice/verify-email");
    assert(verificationUrl.searchParams.get("userId") === userId);
    const code = verificationUrl.searchParams.get("code");
    assert(code);

    expect(await otp.commands.confirmEmailVerificationChallenge({ userId, code })).toEqual({
      status: "confirmation_recorded",
      requestId: input.requestId,
      userId,
    });
    assert((await signIn(runtime, "new-user@example.com")).ok);
    expect(await otp.commands.confirmEmailVerificationChallenge({ userId, code })).toEqual({
      status: "already_confirmed",
    });

    const queue = await runtime.objects.auth
      .singleton()
      .commands.getDurableHookQueue({ pageSize: 100 });
    assert(!queue.items.some((hook) => hook.hookName === "onUserEmailVerified"));
  });

  test("does not deliver a challenge after a newer request supersedes it", async () => {
    const runtime = await createRuntime();
    const { userId } = await signUp(runtime, "superseded@example.com");
    const otp = runtime.objects.otp.singleton();
    const firstInput = {
      userId,
      email: "superseded@example.com",
      publicBaseUrl: "https://backoffice.example",
      requestId: "auth-email-verification-request-1",
    };

    const first = await otp.commands.issueEmailVerification(firstInput);
    const second = await otp.commands.issueEmailVerification({
      ...firstInput,
      requestId: "auth-email-verification-request-2",
    });
    const retriedFirst = await otp.commands.issueEmailVerification(firstInput);

    assert(first.deliverable);
    assert(second.deliverable);
    expect(retriedFirst).toEqual({ deliverable: false, reason: "superseded" });
  });

  test("does not deliver a requested challenge after it expires", async () => {
    const runtime = await createRuntime();
    const otp = runtime.objects.otp.singleton();
    const input = {
      userId: "user-expired-delivery",
      email: "expired-delivery@example.com",
      publicBaseUrl: "https://backoffice.example",
      requestId: "auth-email-verification-expired-delivery",
    };

    const issued = await otp.commands.issueEmailVerification(input);
    assert(issued.deliverable);
    runtime.advanceTime(EMAIL_VERIFICATION_EXPIRY_HOURS * 60 * 60 * 1_000 + 1);

    await expect(otp.commands.issueEmailVerification(input)).resolves.toEqual({
      deliverable: false,
      reason: "expired",
    });
  });

  test("rejects a challenge issued for a different Auth email", async () => {
    const runtime = await createRuntime({ env: { AUTH_EMAIL_VERIFICATION_ENABLED: "true" } });
    const { userId } = await signUp(runtime, "current@example.com");
    const otp = runtime.objects.otp.singleton();
    const issued = await otp.commands.issueEmailVerification({
      userId,
      email: "stale@example.com",
      publicBaseUrl: "https://backoffice.example",
      requestId: "auth-email-verification-hook-stale-email",
    });
    assert(issued.deliverable);
    const code = new URL(issued.url).searchParams.get("code");
    assert(code);

    expect(await otp.commands.confirmEmailVerificationChallenge({ userId, code })).toEqual({
      status: "rejected",
      reason: "invalid",
    });
    assert((await signIn(runtime, "current@example.com")).status === 403);
  });

  test("rejects an invalid persisted payload so durable processing can retry", async () => {
    const runtime = await createRuntime();
    const payload = {
      id: "invalid-email-verification",
      externalId: "user-invalid-payload",
      type: EMAIL_VERIFICATION_TYPE,
      code: "ABC12345",
      confirmedAt: new Date(),
      payload: {
        email: "not-an-email",
        publicBaseUrl: "https://backoffice.example",
        expiresInHours: EMAIL_VERIFICATION_EXPIRY_HOURS,
      },
    } satisfies OtpConfirmedHookPayload;

    await expect(handleEmailVerificationConfirmed(runtime.services, payload)).rejects.toThrow(
      "Invalid email address",
    );
  });

  test("returns typed invalid and expired confirmation outcomes", async () => {
    const runtime = await createRuntime();
    const otp = runtime.objects.otp.singleton();
    const issued = await otp.commands.issueEmailVerification({
      userId: "user-expiring",
      email: "expiring@example.com",
      publicBaseUrl: "https://backoffice.example",
      requestId: "auth-email-verification-hook-expiring",
    });
    assert(issued.deliverable);
    const code = new URL(issued.url).searchParams.get("code");
    assert(code);

    expect(
      await otp.commands.confirmEmailVerificationChallenge({
        userId: "user-expiring",
        code: "WRONGCODE",
      }),
    ).toEqual({ status: "rejected", reason: "invalid" });

    runtime.advanceTime(EMAIL_VERIFICATION_EXPIRY_HOURS * 60 * 60 * 1000 + 1);
    expect(
      await otp.commands.confirmEmailVerificationChallenge({ userId: "user-expiring", code }),
    ).toEqual({
      status: "rejected",
      reason: "expired",
    });
  });
});
