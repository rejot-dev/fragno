import { afterEach, assert, beforeEach, describe, expect, test, vi } from "vitest";

import { FragnoId } from "@fragno-dev/db/schema";

import type { HookContext } from "@fragno-dev/db";

import type { OrganizationHookPayload } from "@/fragno/auth/contracts";

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
import type { AuthObject, BackofficeObjectHandle } from "@/backoffice-runtime/object-registry";
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

async function signUpUnverifiedBackofficeUser(
  auth: BackofficeObjectHandle<AuthObject>,
  email: string,
) {
  const response = await auth.http.fetch(
    new Request("https://backoffice.example/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: email.split("@", 1)[0], email, password: "password123" }),
    }),
  );
  assert(response.ok);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-22T00:00:00.000Z"));
});

afterEach(async () => {
  try {
    await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.cleanup()));
  } finally {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  }
});

describe("Auth Durable Object administration", () => {
  test("creates organizations and manages members through privileged operations", async () => {
    const runtime = await createInMemoryBackofficeRuntime();
    runtimes.push(runtime);
    const auth = runtime.objects.auth.singleton().commands;
    await auth.applyScenarioFixture({
      users: [
        { id: "owner-1", email: "owner@example.com", role: "user", status: "active" },
        { id: "member-1", email: "member@example.com", role: "user", status: "active" },
      ],
    });

    await expect(
      auth.createAdminOrganization({
        name: "Acme",
        slug: "acme",
        ownerEmail: "OWNER@example.com",
      }),
    ).resolves.toEqual({
      organizationId: expect.any(String),
      name: "Acme",
      slug: "acme",
      ownerUserId: "owner-1",
    });
    const organization = (await auth.getAllOrganizations()).find(({ slug }) => slug === "acme");
    assert(organization);

    await expect(
      auth.addAdminOrganizationMember({
        organizationId: organization.id,
        userId: "member-1",
        roles: ["member"],
      }),
    ).resolves.toEqual({
      organizationId: organization.id,
      userId: "member-1",
      roles: ["member"],
    });
    await expect(
      auth.removeAdminOrganizationMember({
        organizationId: organization.id,
        userId: "member-1",
      }),
    ).resolves.toEqual({
      organizationId: organization.id,
      userId: "member-1",
      roles: ["member"],
    });
    await expect(
      auth.hasOrganizationMember({ organizationId: organization.id, userId: "member-1" }),
    ).resolves.toBe(false);
  });

  test("preserves at least one owner when removing organization members", async () => {
    const runtime = await createInMemoryBackofficeRuntime();
    runtimes.push(runtime);
    const auth = runtime.objects.auth.singleton().commands;
    await auth.applyScenarioFixture({
      users: [
        { id: "owner-1", email: "owner@example.com", role: "user", status: "active" },
        { id: "owner-2", email: "replacement@example.com", role: "user", status: "active" },
      ],
    });
    const created = await auth.createAdminOrganization({
      name: "Owner invariant",
      slug: "owner-invariant",
      ownerEmail: "owner@example.com",
    });

    await expect(
      auth.removeAdminOrganizationMember({
        organizationId: created.organizationId,
        userId: "owner-1",
      }),
    ).rejects.toThrow(
      `Admin organization member remove cannot remove the last owner from organization '${created.organizationId}'.`,
    );

    await auth.addAdminOrganizationMember({
      organizationId: created.organizationId,
      userId: "owner-2",
      roles: ["owner"],
    });
    await expect(
      auth.removeAdminOrganizationMember({
        organizationId: created.organizationId,
        userId: "owner-1",
      }),
    ).resolves.toEqual({
      organizationId: created.organizationId,
      userId: "owner-1",
      roles: ["owner"],
    });
  });
});

describe("Auth Durable Object account creation policy", () => {
  test("creates rejot.dev accounts as users outside development", async () => {
    vi.stubEnv("MODE", "production");
    const runtime = await createInMemoryBackofficeRuntime();
    runtimes.push(runtime);

    const response = await runtime.objects.auth.singleton().http.fetch(
      new Request("https://backoffice.example/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Admin",
          email: "admin@rejot.dev",
          password: "password123",
        }),
      }),
    );

    assert(response.ok);
    expect(await response.json()).toMatchObject({
      user: { role: "user" },
    });
  });

  test("creates rejot.dev administrators in development", async () => {
    vi.stubEnv("MODE", "development");
    const runtime = await createInMemoryBackofficeRuntime();
    runtimes.push(runtime);

    const response = await runtime.objects.auth.singleton().http.fetch(
      new Request("https://backoffice.example/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Admin",
          email: "admin@rejot.dev",
          password: "password123",
        }),
      }),
    );

    assert(response.ok);
    expect(await response.json()).toMatchObject({
      user: { role: "admin" },
    });
  });
});

describe("Auth Durable Object administrator granting", () => {
  test("allows an unverified account to become the first administrator", async () => {
    vi.stubEnv("MODE", "production");
    const runtime = await createInMemoryBackofficeRuntime();
    runtimes.push(runtime);
    const auth = runtime.objects.auth.singleton();
    await signUpUnverifiedBackofficeUser(auth, "first-admin@rejot.dev");

    const result = await auth.commands.grantBackofficeAdminByEmail({
      email: "FIRST-ADMIN@rejot.dev",
    });

    assert(result.status === "granted");
    await expect(
      auth.commands.getUserAuthorityFacts({ userId: result.userId }),
    ).resolves.toMatchObject({
      role: "admin",
    });
  });

  test("requires subsequent administrators to have verified their email", async () => {
    vi.stubEnv("MODE", "production");
    const runtime = await createInMemoryBackofficeRuntime();
    runtimes.push(runtime);
    const auth = runtime.objects.auth.singleton();
    await auth.commands.applyScenarioFixture({
      users: [
        {
          id: "admin-1",
          email: "first-admin@rejot.dev",
          role: "admin",
          status: "active",
        },
      ],
    });
    await signUpUnverifiedBackofficeUser(auth, "next-admin@rejot.dev");

    const result = await auth.commands.grantBackofficeAdminByEmail({
      email: "next-admin@rejot.dev",
    });

    assert(result.status === "email_not_verified");
    await expect(
      auth.commands.getUserAuthorityFacts({ userId: result.userId }),
    ).resolves.toMatchObject({
      role: "user",
    });
  });

  test("promotes a verified account when an administrator already exists", async () => {
    const runtime = await createInMemoryBackofficeRuntime();
    runtimes.push(runtime);
    const auth = runtime.objects.auth.singleton();
    await auth.commands.applyScenarioFixture({
      users: [
        {
          id: "admin-1",
          email: "first-admin@rejot.dev",
          role: "admin",
          status: "active",
        },
        {
          id: "user-1",
          email: "next-admin@rejot.dev",
          role: "user",
          status: "active",
        },
      ],
    });

    await expect(
      auth.commands.grantBackofficeAdminByEmail({ email: "NEXT-ADMIN@rejot.dev" }),
    ).resolves.toEqual({ status: "granted", userId: "user-1" });
    await expect(auth.commands.getUserAuthorityFacts({ userId: "user-1" })).resolves.toMatchObject({
      role: "admin",
    });
    await expect(
      auth.commands.grantBackofficeAdminByEmail({ email: "next-admin@rejot.dev" }),
    ).resolves.toEqual({ status: "already_admin", userId: "user-1" });
  });

  test("allows only one concurrent unverified grant to bootstrap administration", async () => {
    vi.stubEnv("MODE", "production");
    const runtime = await createInMemoryBackofficeRuntime();
    runtimes.push(runtime);
    const auth = runtime.objects.auth.singleton();
    await signUpUnverifiedBackofficeUser(auth, "first-admin@rejot.dev");
    await signUpUnverifiedBackofficeUser(auth, "next-admin@rejot.dev");

    const [firstResult, nextResult] = await Promise.all([
      auth.commands.grantBackofficeAdminByEmail({ email: "first-admin@rejot.dev" }),
      auth.commands.grantBackofficeAdminByEmail({ email: "next-admin@rejot.dev" }),
    ]);

    assert(firstResult.status === "granted");
    assert(nextResult.status === "email_not_verified");
    await expect(
      auth.commands.getUserAuthorityFacts({ userId: firstResult.userId }),
    ).resolves.toMatchObject({ role: "admin" });
    await expect(
      auth.commands.getUserAuthorityFacts({ userId: nextResult.userId }),
    ).resolves.toMatchObject({
      role: "user",
    });
  });

  test("reports a missing rejot.dev account", async () => {
    const runtime = await createInMemoryBackofficeRuntime();
    runtimes.push(runtime);

    await expect(
      runtime.objects.auth.singleton().commands.grantBackofficeAdminByEmail({
        email: "missing@rejot.dev",
      }),
    ).resolves.toEqual({ status: "user_not_found" });
  });
});

describe("Auth Durable Object rate limiting", () => {
  test("does not rate limit the public JWKS endpoint", async () => {
    const runtime = await createInMemoryBackofficeRuntime();
    runtimes.push(runtime);
    const auth = runtime.objects.auth.singleton();

    const responses = await Promise.all(
      Array.from({ length: 101 }, () =>
        auth.http.fetch(new Request("https://backoffice.example/api/auth/jwks")),
      ),
    );

    assert(responses.every((response) => response.status === 200));
  });

  test("blocks the fourth authentication attempt within the rate-limit window", async () => {
    const runtime = await createInMemoryBackofficeRuntime();
    runtimes.push(runtime);
    const auth = runtime.objects.auth.singleton();

    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        auth.http.fetch(
          new Request("https://backoffice.example/api/auth/sign-in/email", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              email: "missing@example.com",
              password: "password123",
            }),
          }),
        ),
      ),
    );

    assert(responses.slice(0, 3).every((response) => response.status !== 429));
    assert.equal(responses[3]?.status, 429);
    assert.equal(responses[3]?.headers.get("X-Retry-After"), "10");
  });

  test("opens a new fixed window ten seconds after the first authentication attempt", async () => {
    const runtime = await createInMemoryBackofficeRuntime();
    runtimes.push(runtime);
    const auth = runtime.objects.auth.singleton();
    const attempt = () =>
      auth.http.fetch(
        new Request("https://backoffice.example/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: "missing@example.com",
            password: "password123",
          }),
        }),
      );

    assert((await attempt()).status !== 429);
    vi.advanceTimersByTime(4_000);
    assert((await attempt()).status !== 429);
    vi.advanceTimersByTime(4_000);
    assert((await attempt()).status !== 429);
    vi.advanceTimersByTime(2_000);
    assert((await attempt()).status !== 429);
  });
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

    const response = await runtime.objects.auth.singleton().http.fetch(
      new Request("https://backoffice.example/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "New User",
          email: "new-user@example.com",
          password: "password123",
        }),
      }),
    );
    assert(response.ok);
    await runtime.drain();

    const authCommands = runtime.objects.auth.singleton().commands;
    const firstAuthQueue = await authCommands.getDurableHookQueue({ pageSize: 100 });
    const pendingVerificationHook = firstAuthQueue.items.find(
      (hook) => hook.hookName === "onUserEmailVerificationRequested",
    );
    assert(pendingVerificationHook);
    assert(pendingVerificationHook.status === "pending");
    assert(pendingVerificationHook.nextRetryAt);

    const otpCommands = runtime.objects.otp.singleton().commands;
    const firstOtpQueue = await otpCommands.getDurableHookQueue({ pageSize: 100 });
    const issuedHook = firstOtpQueue.items.find((hook) => hook.hookName === "onOtpIssued");
    assert(issuedHook?.status === "completed");
    assert.equal(resend.queuedEmails.size, 0);
    expect(resend.attempts).toHaveLength(0);
    expect(issueAttempts).toBe(1);

    const retryAt = toTimestamp(pendingVerificationHook.nextRetryAt);
    runtime.advanceTime(Math.max(0, retryAt - runtime.now()));
    await runtime.drain();

    const completedAuthQueue = await authCommands.getDurableHookQueue({ pageSize: 100 });
    const completedVerificationHook = completedAuthQueue.items.find(
      (hook) => hook.hookName === "onUserEmailVerificationRequested",
    );
    assert(completedVerificationHook?.status === "completed");

    const completedOtpQueue = await otpCommands.getDurableHookQueue({ pageSize: 100 });
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

    const response = await runtime.objects.auth.singleton().http.fetch(
      new Request("https://backoffice.example/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "New User",
          email: "new-user@example.com",
          password: "password123",
        }),
      }),
    );
    assert(response.ok);
    await runtime.drain();

    const authCommands = runtime.objects.auth.singleton().commands;
    const firstAuthQueue = await authCommands.getDurableHookQueue({ pageSize: 100 });
    const pendingVerificationHook = firstAuthQueue.items.find(
      (hook) => hook.hookName === "onUserEmailVerificationRequested",
    );
    assert(pendingVerificationHook?.status === "pending");
    assert(pendingVerificationHook.nextRetryAt);

    const otpCommands = runtime.objects.otp.singleton().commands;
    const otpQueue = await otpCommands.getDurableHookQueue({ pageSize: 100 });
    const issuedHook = otpQueue.items.find((hook) => hook.hookName === "onOtpIssued");
    assert(issuedHook?.status === "completed");
    expect(resend.attempts).toHaveLength(1);
    assert.equal(resend.queuedEmails.size, 1);

    const retryAt = toTimestamp(pendingVerificationHook.nextRetryAt);
    runtime.advanceTime(Math.max(0, retryAt - runtime.now()));
    await runtime.drain();

    const completedAuthQueue = await authCommands.getDurableHookQueue({ pageSize: 100 });
    const completedVerificationHook = completedAuthQueue.items.find(
      (hook) => hook.hookName === "onUserEmailVerificationRequested",
    );
    assert(completedVerificationHook?.status === "completed");
    expect(resend.attempts).toHaveLength(2);
    assert.equal(new Set(resend.attempts.map((attempt) => attempt.idempotencyKey)).size, 1);
    assert.equal(resend.queuedEmails.size, 1);
  });
});

describe("Auth session organization bootstrap", () => {
  test("sets the personal organization active after sign-up", async () => {
    const runtime = await createInMemoryBackofficeRuntime({
      env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false" },
    });
    runtimes.push(runtime);
    const auth = runtime.objects.auth.singleton();

    const signUpResponse = await auth.http.fetch(
      new Request("https://backoffice.example/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "New User",
          email: "new-user@example.com",
          password: "password123",
        }),
      }),
    );
    if (!signUpResponse.ok) {
      assert.fail(await signUpResponse.text());
    }
    const cookie = signUpResponse.headers.get("set-cookie");
    assert(cookie);
    await runtime.drain();

    const organizationId = (await auth.commands.getAllOrganizations())[0]?.id;
    assert(organizationId);

    const tokenResponse = await auth.http.fetch(
      new Request("https://backoffice.example/api/auth/backoffice-token", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ selection: "required", organizationId }),
      }),
    );
    assert(tokenResponse.status === 200);
  });
});

describe("Auth organization automation hooks", () => {
  test("forwards the active hook propagation context to Automations RPC", async () => {
    const ingestEvent = vi.fn().mockResolvedValue({ accepted: true });
    const runtime = {
      objects: {
        automations: {
          singleton: () => ({ commands: { ingestEvent } }),
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
