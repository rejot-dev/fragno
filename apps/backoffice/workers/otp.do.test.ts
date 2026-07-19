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

import type { DurableUserEmailVerifiedHookPayload } from "@fragno-dev/auth";
import type { ResolvedOtpConfirmedHookPayload } from "@fragno-dev/otp-fragment";

import { createInMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import { EMAIL_VERIFICATION_EXPIRY_HOURS, EMAIL_VERIFICATION_TYPE } from "@/fragno/otp";

import { handleEmailVerificationConfirmed } from "./otp.do";

const runtimes: Array<Awaited<ReturnType<typeof createInMemoryBackofficeRuntime>>> = [];

const createRuntime = async () => {
  const runtime = await createInMemoryBackofficeRuntime();
  runtimes.push(runtime);
  return runtime;
};

const signUp = async (
  runtime: Awaited<ReturnType<typeof createInMemoryBackofficeRuntime>>,
  email: string,
) => {
  const response = await runtime.objects.auth.singleton().fetch(
    new Request("https://backoffice.example/api/auth/sign-up", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    }),
  );
  assert(response.ok);
  return (await response.json()) as { userId: string };
};

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.cleanup()));
});

describe("OTP Durable Object email verification", () => {
  test("idempotently issues a singleton challenge and verifies the Auth email", async () => {
    const runtime = await createRuntime();
    const { userId } = await signUp(runtime, "new-user@example.com");
    const otp = runtime.objects.otp.singleton();
    const input = {
      userId,
      email: "new-user@example.com",
      publicBaseUrl: "https://backoffice.example",
      otpId: "auth-user-created-hook-1",
    };

    const first = await otp.issueEmailVerification(input);
    const repeated = await otp.issueEmailVerification(input);

    expect(repeated).toEqual(first);
    expect(first.expiresInHours).toBe(EMAIL_VERIFICATION_EXPIRY_HOURS);
    await expect(
      otp.issueEmailVerification({ ...input, email: "different@example.com" }),
    ).rejects.toThrow("OTP id cannot be reused with different delivery input");
    const verificationUrl = new URL(first.url);
    assert(verificationUrl.pathname === "/backoffice/verify-email");
    assert(verificationUrl.searchParams.get("userId") === userId);
    const code = verificationUrl.searchParams.get("code");
    assert(code);

    expect(await otp.confirmEmailVerification({ userId, code })).toEqual({
      ok: true,
      userId,
    });
    await runtime.drain();

    const repository = await runtime.objects.auth.singleton().getDurableHookRepository();
    const queue = await repository.getHookQueue({ pageSize: 100 });
    const verificationHook = queue.items.find((hook) => hook.hookName === "onUserEmailVerified");
    assert(verificationHook);
    const payload = verificationHook.payload as DurableUserEmailVerifiedHookPayload;
    expect(payload).toMatchObject({
      user: { id: userId, email: "new-user@example.com" },
      actor: null,
    });
    expect(new Date(payload.emailVerifiedAt).toString()).not.toBe("Invalid Date");
  });

  test("treats a changed Auth email as a terminal confirmation outcome", async () => {
    const runtime = await createRuntime();
    const { userId } = await signUp(runtime, "current@example.com");
    const otp = runtime.objects.otp.singleton();
    const issued = await otp.issueEmailVerification({
      userId,
      email: "stale@example.com",
      publicBaseUrl: "https://backoffice.example",
      otpId: "auth-user-created-hook-stale-email",
    });
    const code = new URL(issued.url).searchParams.get("code");
    assert(code);

    expect(await otp.confirmEmailVerification({ userId, code })).toEqual({ ok: true, userId });
    await runtime.drain();

    const authRepository = await runtime.objects.auth.singleton().getDurableHookRepository();
    const authQueue = await authRepository.getHookQueue({ pageSize: 100 });
    assert(!authQueue.items.some((hook) => hook.hookName === "onUserEmailVerified"));

    const otpRepository = await otp.getDurableHookRepository();
    const otpQueue = await otpRepository.getHookQueue({ pageSize: 100 });
    const confirmedHook = otpQueue.items.find((hook) => hook.hookName === "onOtpConfirmed");
    assert(confirmedHook);
    assert(confirmedHook.status === "completed");
  });

  test("rejects an invalid persisted payload so durable processing can retry", async () => {
    const runtime = await createRuntime();
    const now = new Date();
    const payload = {
      id: "invalid-email-verification",
      externalId: "user-invalid-payload",
      type: EMAIL_VERIFICATION_TYPE,
      code: "ABC12345",
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      confirmedAt: now,
      payload: {
        email: "not-an-email",
        publicBaseUrl: "https://backoffice.example",
        expiresInHours: EMAIL_VERIFICATION_EXPIRY_HOURS,
      },
    } satisfies ResolvedOtpConfirmedHookPayload;

    await expect(handleEmailVerificationConfirmed(runtime.services, payload)).rejects.toThrow(
      "Invalid email address",
    );
  });

  test("returns typed invalid and expired confirmation outcomes", async () => {
    const runtime = await createRuntime();
    const otp = runtime.objects.otp.singleton();
    const issued = await otp.issueEmailVerification({
      userId: "user-expiring",
      email: "expiring@example.com",
      publicBaseUrl: "https://backoffice.example",
      otpId: "auth-user-created-hook-expiring",
    });
    const code = new URL(issued.url).searchParams.get("code");
    assert(code);

    expect(
      await otp.confirmEmailVerification({ userId: "user-expiring", code: "WRONGCODE" }),
    ).toEqual({ ok: false, error: "OTP_INVALID" });

    runtime.advanceTime(EMAIL_VERIFICATION_EXPIRY_HOURS * 60 * 60 * 1000 + 1);
    expect(await otp.confirmEmailVerification({ userId: "user-expiring", code })).toEqual({
      ok: false,
      error: "OTP_EXPIRED",
    });
  });
});
