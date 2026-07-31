import { describe, test, vi } from "vitest";

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";

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

import { backofficeFiles, defineBackofficeScenario, runBackofficeScenario } from "./scenario";

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
    role: "initiator" as const,
  };

  return {
    id,
    scope: { kind: "org", orgId: "org-1" },
    source: "telegram",
    eventType: "message.received",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: {
      chatId,
      text,
    },
    actors: {
      initiator: actor,
      principal: null,
      delegation: [],
    },
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
    role: "initiator" as const,
  };

  return {
    id: `identity-claim-completed:${otpId}`,
    scope: { kind: "org", orgId: "org-1" },
    source: "otp",
    eventType: "identity.claim.completed",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: {
      otpId,
      claimType: "identity_link",
    },
    actors: {
      initiator: actor,
      principal: null,
      delegation: [],
    },
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
              "resolve existing telegram user link",
              "create telegram identity claim",
              "store telegram claim workflow binding",
              "send telegram identity claim link",
            ],
          }),

          when.otp.confirmClaimFromCapturedUrl({
            url: "claimUrl",
            subjectUserId: "user-1",
          }),

          then.assert(
            "assert the Telegram identity was bound before workflow completion",
            async (ctx) => {
              const scope = { kind: "org" as const, orgId: "org-1" };
              const binding = await ctx.runtime.objects.automations
                .for(scope)
                .resolveExternalIdentity(
                  {
                    identity: {
                      scope: "external",
                      source: "telegram",
                      type: "chat",
                      id: "1001",
                    },
                  },
                  { execution: createBackofficeSystemExecution(scope) },
                );
              if (binding?.userId !== "user-1") {
                throw new Error(
                  `Expected Telegram identity binding for user-1, got ${JSON.stringify(binding)}.`,
                );
              }
            },
          ),

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
            instanceId: "telegram-link-message-10001",
            status: "waiting",
            waitingFor: "identity-claim-completed",
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-linking",
            instanceId: "telegram-link-message-10002",
            status: "waiting",
            waitingFor: "identity-claim-completed",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("resolves an already linked Telegram chat without creating another claim", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter telegram /start resolves an already linked chat",
        files: backofficeFiles.workspaceStarter(),
        fakes: ({ fake }) => ({ telegram: fake.telegram() }),
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.identity.binding({
            orgId: "org-1",
            externalId: "1001",
            userId: "user-1",
          }),
        ],
        steps: ({ when, then }) => [
          when.workflow.createInstance({
            orgId: "org-1",
            remoteWorkflowName: "telegram-user-linking",
            instanceId: "telegram-link-already-linked",
            params: telegramLinkingWorkflowParams({
              instanceId: "telegram-link-already-linked",
              event: telegramMessageEvent({
                id: "telegram:message:already-linked",
                text: "/start",
              }),
            }),
          }),

          then.telegram.sentMessage({
            chatId: "1001",
            text: "This Telegram chat is already linked.",
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-linking",
            instanceId: "telegram-link-already-linked",
            status: "complete",
            output: {
              linked: true,
              alreadyLinked: true,
              userId: "user-1",
            },
          }),
          then.workflow.steps({
            remoteWorkflowName: "telegram-user-linking",
            instanceId: "telegram-link-already-linked",
            include: [
              "resolve existing telegram user link",
              "send already linked telegram message",
            ],
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
