import { describe, test, vi } from "vitest";

import type { AutomationEvent } from "./contracts";

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

import { createRouteBackedAutomationStoreRuntime } from "./bindings-route-runtime";
import {
  backofficeFiles,
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "./scenario";

const telegramMessageEvent = ({
  id,
  text,
  chatId = "1001",
}: {
  id: string;
  text: string;
  chatId?: string;
}): AutomationEvent => {
  const actor = {
    scope: "external" as const,
    source: "telegram",
    type: "chat",
    id: chatId,
  };

  return {
    id,
    orgId: "org-1",
    source: "telegram",
    eventType: "message.received",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: {
      chatId,
      text,
    },
    actor,
    actors: [actor],
    subject: { orgId: "org-1" },
  };
};

const identityClaimCompletedEvent = ({
  otpId,
  subjectUserId = "user-1",
  actorSource = "telegram",
  actorType = "chat",
  actorId = "1001",
}: {
  otpId: string;
  subjectUserId?: string;
  actorSource?: string;
  actorType?: string;
  actorId?: string;
}): AutomationEvent => {
  const actor = {
    scope: "external" as const,
    source: actorSource,
    type: actorType,
    id: actorId,
  };

  return {
    id: `identity-claim-completed:${otpId}`,
    orgId: "org-1",
    source: "otp",
    eventType: "identity.claim.completed",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: {
      otpId,
      claimType: "identity_link",
    },
    actor,
    actors: [actor],
    subject: { userId: subjectUserId },
  };
};

const telegramLinkingWorkflowParams = (input: { instanceId: string; event: AutomationEvent }) => ({
  automationEvent: input.event,
  workflowInstanceId: input.instanceId,
  workflowScriptPath: "/workspace/automations/telegram-user-linking.workflow.js",
});

describe("starter OTP linking automation in memory", () => {
  test("routes Telegram /start through OTP confirmation and links the Telegram chat", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter telegram /start links a chat through OTP",

        files: backofficeFiles.workspaceStarter(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
        ],

        steps: ({ when, then }) => [
          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 10_001,
            messageId: 501,
            chatId: "1001",
            text: "/start",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.telegram.sentMessage({
            chatId: "1001",
            text: /Open this link to finish linking your Telegram account/u,
            captureUrlAs: "claimUrl",
          }),

          then.workflow.instance({
            remoteWorkflowName: "telegram-user-linking",
            status: "waiting",
            waitingFor: "identity-claim-completed",
          }),

          then.workflow.steps({
            remoteWorkflowName: "telegram-user-linking",
            include: [
              "lookup existing telegram user link",
              "create telegram identity claim",
              "store telegram claim workflow binding",
              "send telegram identity claim link",
            ],
          }),

          when.otp.confirmClaimFromCapturedUrl({
            url: "claimUrl",
            subjectUserId: "user-1",
          }),

          then.store.entry({
            orgId: "org-1",
            key: "telegram/1001",
            value: "user-1",
          }),

          then.telegram.sentMessage({
            chatId: "1001",
            text: "Your Telegram chat is now linked.",
          }),

          then.workflow.instance({
            remoteWorkflowName: "telegram-user-linking",
            status: "complete",
            output: { linked: true, userId: "user-1" },
          }),

          then.workflow.event({
            remoteWorkflowName: "telegram-user-linking",
            type: "identity-claim-completed",
            payload: {
              source: "otp",
              eventType: "identity.claim.completed",
              subject: { userId: "user-1" },
            },
            consumedByStepKey: "waitForEvent:identity-claim-completed",
          }),

          then.workflow.noErrored({ orgId: "org-1" }),
          then.hooks.noPending({
            orgId: "org-1",
            fragments: ["automations", "telegram"],
          }),
        ],
      }),
    );
  });

  test("starts separate Telegram user-linking workflows for separate /start event ids", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter telegram /start creates event-keyed linking workflows",

        files: backofficeFiles.workspaceStarter(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
        ],

        steps: ({ when, then }) => [
          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 10_001,
            messageId: 501,
            chatId: "1001",
            text: "/start",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),
          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 10_002,
            messageId: 502,
            chatId: "1001",
            text: "/start",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.assert("assert two claim links were sent", (ctx) => {
            const calls = ctx.fakes.telegram?.sendMessageCalls ?? [];
            if (calls.length !== 2) {
              throw new Error(`Expected two claim link messages, got ${calls.length}.`);
            }
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-linking",
            instanceId: "telegram-link-telegram-org-1-10001-1001-501",
            status: "waiting",
            waitingFor: "identity-claim-completed",
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-linking",
            instanceId: "telegram-link-telegram-org-1-10002-1001-502",
            status: "waiting",
            waitingFor: "identity-claim-completed",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("routes Telegram /start for an already linked chat", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter telegram /start reports an already linked chat",

        files: backofficeFiles.workspaceStarter(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.store.entry({
            orgId: "org-1",
            key: "telegram/1001",
            value: "user-1",
          }),
        ],

        steps: ({ when, then }) => [
          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 10_002,
            messageId: 502,
            chatId: "1001",
            text: "/start",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.telegram.sentMessage({
            chatId: "1001",
            text: "This Telegram chat is already linked.",
          }),

          then.assert("assert only the already-linked Telegram reply was sent", (ctx) => {
            const calls = ctx.fakes.telegram?.sendMessageCalls ?? [];
            if (calls.length !== 1) {
              throw new Error(`Expected one Telegram message, got ${calls.length}.`);
            }
          }),

          then.workflow.instance({
            remoteWorkflowName: "telegram-user-linking",
            status: "complete",
            output: {
              linked: true,
              alreadyLinked: true,
              userId: "user-1",
            },
          }),

          then.workflow.steps({
            remoteWorkflowName: "telegram-user-linking",
            include: ["lookup existing telegram user link", "send already linked telegram message"],
          }),

          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("OTP completion with no stored workflow binding is a no-op", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter OTP completion without workflow binding is ignored",

        files: backofficeFiles.workspaceStarter(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
        ],

        steps: ({ when, then }) => [
          when.otp.confirmClaim({
            orgId: "org-1",
            otpId: "otp-missing-binding",
            subjectUserId: "user-1",
            actor: { id: "1001" },
          }),

          then.telegram.noMessages(),
          then.workflow.missing({ remoteWorkflowName: "telegram-user-linking" }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("telegram-user-linking skips non-/start Telegram events", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "telegram-user-linking skips non-start Telegram events",

        files: backofficeFiles.workspaceStarter(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
        ],

        steps: ({ when, then }) => [
          when.workflow.createInstance({
            orgId: "org-1",
            remoteWorkflowName: "telegram-user-linking",
            instanceId: "telegram-link-non-start",
            params: telegramLinkingWorkflowParams({
              instanceId: "telegram-link-non-start",
              event: telegramMessageEvent({
                id: "telegram:message:non-start",
                text: "hello",
              }),
            }),
          }),

          then.telegram.noMessages(),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-linking",
            instanceId: "telegram-link-non-start",
            status: "complete",
            output: { skipped: true, reason: "not-telegram-start" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("telegram-user-linking rejects a completed claim with a different OTP id", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "telegram-user-linking rejects a mismatched OTP claim",

        files: backofficeFiles.workspaceStarter(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
        ],

        steps: ({ when, then }) => [
          when.workflow.createInstance({
            orgId: "org-1",
            remoteWorkflowName: "telegram-user-linking",
            instanceId: "telegram-link-claim-mismatch",
            params: telegramLinkingWorkflowParams({
              instanceId: "telegram-link-claim-mismatch",
              event: telegramMessageEvent({
                id: "telegram:message:claim-mismatch",
                text: "/start",
              }),
            }),
          }),

          then.telegram.sentMessage({
            chatId: "1001",
            text: /Open this link to finish linking your Telegram account/u,
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-linking",
            instanceId: "telegram-link-claim-mismatch",
            status: "waiting",
            waitingFor: "identity-claim-completed",
          }),

          when.workflow.sendEvent({
            orgId: "org-1",
            instanceId: "telegram-link-claim-mismatch",
            type: "identity-claim-completed",
            payload: identityClaimCompletedEvent({ otpId: "different-otp-id" }),
          }),

          then.store.missing({
            orgId: "org-1",
            key: "telegram/1001",
          }),
          then.assert("assert no linked Telegram reply was sent", (ctx) => {
            const calls = ctx.fakes.telegram?.sendMessageCalls ?? [];
            if (calls.length !== 1) {
              throw new Error(`Expected only the claim link message, got ${calls.length}.`);
            }
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-linking",
            instanceId: "telegram-link-claim-mismatch",
            status: "complete",
            output: { linked: false, reason: "claim-mismatch" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("telegram-user-linking rejects a completed claim from a non-Telegram actor", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "telegram-user-linking rejects a non-Telegram claim actor",

        files: backofficeFiles.workspaceStarter(),

        vars: () => ({ otpId: "" }),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
        ],

        steps: ({ when, then }) => [
          when.workflow.createInstance({
            orgId: "org-1",
            remoteWorkflowName: "telegram-user-linking",
            instanceId: "telegram-link-non-telegram-actor",
            params: telegramLinkingWorkflowParams({
              instanceId: "telegram-link-non-telegram-actor",
              event: telegramMessageEvent({
                id: "telegram:message:non-telegram-actor",
                text: "/start",
              }),
            }),
          }),

          then.telegram.sentMessage({
            chatId: "1001",
            text: /Open this link to finish linking your Telegram account/u,
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-linking",
            instanceId: "telegram-link-non-telegram-actor",
            status: "waiting",
            waitingFor: "identity-claim-completed",
          }),
          then.assert("capture generated OTP id from the claim workflow binding", async (ctx) => {
            const entries = await createRouteBackedAutomationStoreRuntime({
              object: ctx.runtime.objects.automations.forOrg("org-1"),
              orgId: "org-1",
            }).list({
              prefix: "telegram/claim-workflow/",
              limit: 10,
            });
            const entry = entries.find(
              (candidate) => candidate.value === "telegram-link-non-telegram-actor",
            );
            if (!entry) {
              throw new Error(`Expected claim workflow binding, got ${JSON.stringify(entries)}.`);
            }
            ctx.vars.otpId = entry.key.replace("telegram/claim-workflow/", "");
          }),

          when.workflow.sendEvent({
            orgId: "org-1",
            instanceId: "telegram-link-non-telegram-actor",
            type: "identity-claim-completed",
            payload: (ctx: BackofficeScenarioContext<{ otpId: string }>) =>
              identityClaimCompletedEvent({
                otpId: ctx.vars.otpId,
                actorSource: "github",
                actorType: "user",
                actorId: "octocat",
              }),
          }),

          then.store.missing({
            orgId: "org-1",
            key: "telegram/1001",
          }),
          then.assert("assert no linked Telegram reply was sent", (ctx) => {
            const calls = ctx.fakes.telegram?.sendMessageCalls ?? [];
            if (calls.length !== 1) {
              throw new Error(`Expected only the claim link message, got ${calls.length}.`);
            }
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-linking",
            instanceId: "telegram-link-non-telegram-actor",
            status: "complete",
            output: { linked: false, reason: "not-telegram" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("telegram-user-linking times out when the claim is not completed", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "telegram-user-linking claim wait times out",

        files: backofficeFiles.workspaceStarter(),

        options: {
          allowErroredWorkflows: true,
        },

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
        ],

        steps: ({ when, then }) => [
          when.workflow.createInstance({
            orgId: "org-1",
            remoteWorkflowName: "telegram-user-linking",
            instanceId: "telegram-link-timeout",
            params: telegramLinkingWorkflowParams({
              instanceId: "telegram-link-timeout",
              event: telegramMessageEvent({
                id: "telegram:message:claim-timeout",
                text: "/start",
              }),
            }),
          }),

          then.telegram.sentMessage({
            chatId: "1001",
            text: /Open this link to finish linking your Telegram account/u,
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-linking",
            instanceId: "telegram-link-timeout",
            status: "waiting",
            waitingFor: "identity-claim-completed",
          }),

          when.time.advance("15 minutes"),

          then.workflow.instance({
            remoteWorkflowName: "telegram-user-linking",
            instanceId: "telegram-link-timeout",
            status: "errored",
          }),
          then.store.missing({
            orgId: "org-1",
            key: "telegram/1001",
          }),
          then.assert("assert no linked Telegram reply was sent", (ctx) => {
            const calls = ctx.fakes.telegram?.sendMessageCalls ?? [];
            if (calls.length !== 1) {
              throw new Error(`Expected only the claim link message, got ${calls.length}.`);
            }
          }),
        ],
      }),
    );
  });
});
