import { afterEach, assert, beforeEach, describe, expect, test, vi } from "vitest";

import { FragnoId } from "@fragno-dev/db/schema";

import type { OrganizationHookPayload } from "@fragno-dev/auth";
import type { HookContext } from "@fragno-dev/db";

const { DurableObject, RpcTarget, WorkerEntrypoint, tracing } = vi.hoisted(() => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  class MockRpcTarget {}
  class MockWorkerEntrypoint {}

  return {
    DurableObject: MockDurableObject,
    RpcTarget: MockRpcTarget,
    WorkerEntrypoint: MockWorkerEntrypoint,
    tracing: {
      enterSpan: vi.fn((_name: string, callback: (span: unknown) => unknown) =>
        callback({ isTraced: true, setAttribute: vi.fn() }),
      ),
    },
  };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint, tracing }));

import type { ResendSendEmailInput } from "@fragno-dev/resend-fragment";

import { createInMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { AUTH_AUTOMATION_EVENT_ORGANIZATION_CREATED } from "@/fragno/backoffice-capabilities/capabilities/auth";

import { createOrganizationAutomationHooks } from "./auth.do";
import {
  InMemoryOtpObject,
  type IssueEmailVerificationInput,
  type IssueEmailVerificationResult,
} from "./otp.do";

const runtimes: Array<Awaited<ReturnType<typeof createInMemoryBackofficeRuntime>>> = [];

class RecordingResendObject {
  loseNextQueueResponse = false;
  readonly attempts: Array<{
    input: ResendSendEmailInput;
    idempotencyKey: string;
  }> = [];
  readonly queuedEmails = new Map<string, ResendSendEmailInput>();

  async queueEmail(input: ResendSendEmailInput, options: { idempotencyKey: string }) {
    this.attempts.push({ input, idempotencyKey: options.idempotencyKey });
    this.queuedEmails.set(options.idempotencyKey, input);

    if (this.loseNextQueueResponse) {
      this.loseNextQueueResponse = false;
      throw new Error("Simulated lost Resend queue response.");
    }
  }
}

const toTimestamp = (value: Date | string): number =>
  value instanceof Date ? value.getTime() : new Date(value).getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-22T00:00:00.000Z"));
});

afterEach(async () => {
  try {
    await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.cleanup()));
  } finally {
    vi.useRealTimers();
  }
});

describe("Auth Durable Object email verification delivery", () => {
  test("reuses the OTP after a committed issuance response is lost", async () => {
    let issueAttempts = 0;
    let loseFirstIssueResponse = true;
    const resend = new RecordingResendObject();
    const runtime = await createInMemoryBackofficeRuntime({
      env: { AUTH_EMAIL_VERIFICATION_ENABLED: "true" },
      objectFactories: {
        OTP: ({ state, env, runtime: runtimeServices }) =>
          new (class extends InMemoryOtpObject {
            override async issueEmailVerification(
              input: IssueEmailVerificationInput,
            ): Promise<IssueEmailVerificationResult> {
              issueAttempts += 1;
              const issued = await super.issueEmailVerification(input);
              if (loseFirstIssueResponse) {
                loseFirstIssueResponse = false;
                throw new Error("Simulated lost OTP issuance response.");
              }
              return issued;
            }
          })({ state, env, runtime: runtimeServices }),
        RESEND: () => resend,
      },
    });
    runtimes.push(runtime);

    const response = await runtime.objects.auth.singleton().fetch(
      new Request("https://backoffice.example/api/auth/sign-up", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "new-user@example.com",
          password: "password123",
        }),
      }),
    );
    assert(response.ok);
    await runtime.drain();

    const authRepository = await runtime.objects.auth.singleton().getDurableHookRepository();
    const firstAuthQueue = await authRepository.getHookQueue({ pageSize: 100 });
    const pendingVerificationHook = firstAuthQueue.items.find(
      (hook) => hook.hookName === "onUserEmailVerificationRequested",
    );
    assert(pendingVerificationHook);
    assert(pendingVerificationHook.status === "pending");
    assert(pendingVerificationHook.nextRetryAt);

    const otpRepository = await runtime.objects.otp.singleton().getDurableHookRepository();
    const firstOtpQueue = await otpRepository.getHookQueue({ pageSize: 100 });
    const issuedHook = firstOtpQueue.items.find((hook) => hook.hookName === "onOtpIssued");
    assert(issuedHook?.status === "completed");
    assert.equal(resend.queuedEmails.size, 0);
    expect(resend.attempts).toHaveLength(0);
    expect(issueAttempts).toBe(1);

    const retryAt = toTimestamp(pendingVerificationHook.nextRetryAt);
    runtime.advanceTime(Math.max(0, retryAt - runtime.now()));
    await runtime.drain();

    const completedAuthQueue = await authRepository.getHookQueue({ pageSize: 100 });
    const completedVerificationHook = completedAuthQueue.items.find(
      (hook) => hook.hookName === "onUserEmailVerificationRequested",
    );
    assert(completedVerificationHook?.status === "completed");

    const completedOtpQueue = await otpRepository.getHookQueue({ pageSize: 100 });
    expect(completedOtpQueue.items.filter((hook) => hook.hookName === "onOtpIssued")).toHaveLength(
      1,
    );
    expect(issueAttempts).toBe(2);
    assert.equal(resend.queuedEmails.size, 1);
    expect(resend.attempts).toHaveLength(1);
  });

  test("reuses the email idempotency key after a committed queue response is lost", async () => {
    const resend = new RecordingResendObject();
    resend.loseNextQueueResponse = true;
    const runtime = await createInMemoryBackofficeRuntime({
      env: { AUTH_EMAIL_VERIFICATION_ENABLED: "true" },
      objectFactories: {
        RESEND: () => resend,
      },
    });
    runtimes.push(runtime);

    const response = await runtime.objects.auth.singleton().fetch(
      new Request("https://backoffice.example/api/auth/sign-up", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "new-user@example.com",
          password: "password123",
        }),
      }),
    );
    assert(response.ok);
    await runtime.drain();

    const authRepository = await runtime.objects.auth.singleton().getDurableHookRepository();
    const firstAuthQueue = await authRepository.getHookQueue({ pageSize: 100 });
    const pendingVerificationHook = firstAuthQueue.items.find(
      (hook) => hook.hookName === "onUserEmailVerificationRequested",
    );
    assert(pendingVerificationHook?.status === "pending");
    assert(pendingVerificationHook.nextRetryAt);

    const otpRepository = await runtime.objects.otp.singleton().getDurableHookRepository();
    const otpQueue = await otpRepository.getHookQueue({ pageSize: 100 });
    const issuedHook = otpQueue.items.find((hook) => hook.hookName === "onOtpIssued");
    assert(issuedHook?.status === "completed");
    expect(resend.attempts).toHaveLength(1);
    assert.equal(resend.queuedEmails.size, 1);

    const retryAt = toTimestamp(pendingVerificationHook.nextRetryAt);
    runtime.advanceTime(Math.max(0, retryAt - runtime.now()));
    await runtime.drain();

    const completedAuthQueue = await authRepository.getHookQueue({ pageSize: 100 });
    const completedVerificationHook = completedAuthQueue.items.find(
      (hook) => hook.hookName === "onUserEmailVerificationRequested",
    );
    assert(completedVerificationHook?.status === "completed");
    expect(resend.attempts).toHaveLength(2);
    assert.equal(new Set(resend.attempts.map((attempt) => attempt.idempotencyKey)).size, 1);
    assert.equal(resend.queuedEmails.size, 1);
  });
});

describe("Auth organization automation hooks", () => {
  test("forwards the active hook propagation context to Automations RPC", async () => {
    const ingestEvent = vi.fn().mockResolvedValue({ accepted: true });
    const runtime = {
      objects: {
        automations: {
          singleton: () => ({ ingestEvent }),
        },
      },
    } as unknown as BackofficeRuntimeServices;
    const hooks = createOrganizationAutomationHooks(runtime);
    const payload: OrganizationHookPayload = {
      organization: {
        id: "org-1",
        name: "Example",
        slug: "example",
        createdBy: "user-1",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      },
      actor: null,
    };
    const propagationContext = {
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-01",
      tracestate: "vendor=value",
    };

    const hookContext = {
      hookId: FragnoId.fromExternal("hook-1", 0),
      idempotencyKey: "nonce-1",
      capturePropagationContext: vi.fn(() => propagationContext),
    } as unknown as HookContext;

    await hooks.onOrganizationCreated?.(payload, hookContext);

    expect(ingestEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "hook-1",
        eventType: AUTH_AUTOMATION_EVENT_ORGANIZATION_CREATED,
      }),
      { propagationContext },
    );
    expect(hookContext.capturePropagationContext).toHaveBeenCalledOnce();
  });
});
