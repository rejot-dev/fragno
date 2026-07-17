import { assert, describe, test, vi } from "vitest";

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

import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "./scenario";

const getUserCreatedHook = async (ctx: BackofficeScenarioContext) => {
  const repository = await ctx.runtime.objects.auth.singleton().getDurableHookRepository();
  const queue = await repository.getHookQueue({ pageSize: 100 });
  const hook = queue.items.find((item) => item.hookName === "onUserCreated");
  assert(hook, "Expected Auth onUserCreated hook to exist.");
  return hook;
};

describe("Auth transactional email scenarios", () => {
  test("sign-up queues the welcome email", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "auth sign-up queues the welcome email",
        env: { TRANSACTIONAL_EMAILS_ENABLED: "true" },
        fakes: ({ fake }) => ({ resend: fake.resend() }),
        steps: ({ when, then }) => [
          when.auth.signUp({ email: "new-user@example.com" }),
          then.resend.queuedEmail({
            to: "new-user@example.com",
            subject: "Welcome to Fragno Backoffice",
            text: /Your account is ready/u,
            idempotencyKey: /^auth:user-created:[^:]+:[^:]+$/u,
          }),
        ],
      }),
    );
  });

  test("sign-up remains committed and retries when singleton Resend is unconfigured", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "auth sign-up retries email when singleton Resend is unconfigured",
        env: { TRANSACTIONAL_EMAILS_ENABLED: "true" },
        steps: ({ when, then }) => [
          when.auth.signUp({ email: "new-user@example.com" }),
          then.assert("welcome email hook remains retryable", async (ctx) => {
            const resendConfig = await ctx.runtime.objects.resend.singleton().getAdminConfig();
            assert(!resendConfig.configured);

            const hook = await getUserCreatedHook(ctx);
            assert.equal(hook.status, "pending");
            assert.equal(hook.attempts, 1);
            assert(hook.nextRetryAt);
            assert.match(hook.error ?? "", /Resend is not configured for email delivery/u);
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
        ],
      }),
    );
  });
});
