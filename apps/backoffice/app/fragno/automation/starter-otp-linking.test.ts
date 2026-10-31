import { describe, test, vi } from "vitest";

import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";

import { createAutomationRuntimeExecution } from "./authority";

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

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";

import { ApiObject } from "../../../workers/api-object";
import { AppInstallationsObject } from "../../../workers/app-installations-object";
import { AppsObject } from "../../../workers/apps-object";
import { AuthObject } from "../../../workers/auth-object";
import { AutomationsObject } from "../../../workers/automations-object";
import { BillingObject } from "../../../workers/billing-object";
import { CodemodeObject } from "../../../workers/codemode-object";
import { FormsObject } from "../../../workers/forms-object";
import { GitHubObject } from "../../../workers/github-object";
import { MarketplaceObject } from "../../../workers/marketplace-object";
import { McpObject } from "../../../workers/mcp-object";
import { OtpObject } from "../../../workers/otp-object";
import { ResendObject } from "../../../workers/resend-object";
import { UploadObject } from "../../../workers/upload-object";
import { defineBackofficeScenario, runBackofficeScenario } from "./scenario";

const scenarioObjects = {
  API: (input) => new ApiObject(input),
  APPS: (input) => new AppsObject(input),
  APP_INSTALLATIONS: (input) => new AppInstallationsObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  BILLING: (input) => new BillingObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  FORMS: (input) => new FormsObject(input),
  GITHUB: (input) => new GitHubObject(input),
  MARKETPLACE: (input) => new MarketplaceObject(input),
  MCP: (input) => new McpObject(input),
  OTP: (input) => new OtpObject(input),
  // The Telegram channel's install workflow defines its agent.
  PI_MANAGER: allLocalObjects.PI_MANAGER,
  RESEND: (input) => new ResendObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

// A chosen folder outside `/workspace/automations`, as the Marketplace install form allows.
const TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION = {
  targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
  slug: "telegram-channel",
  version: "3.0.0",
  installationRoot: "/workspace/telegram-channel",
} as const;

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
    type: "user",
    id: chatId,
    role: "initiator" as const,
  };

  return {
    id,
    scopeRestriction: null,
    scope: { kind: "org", orgId: "org-1", jurisdiction: null },
    source: "telegram",
    eventType: "message.received",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: {
      messageId: id,
      chatId,
      fromUserId: chatId,
      text,
    },
    actors: {
      initiator: actor,
      principal: null,
      delegation: [],
    },
    subject: { scope: { kind: "org", orgId: "org-1", jurisdiction: null } },
    causation: { kind: "origin" },
  };
};

const identityClaimCompletedEvent = ({
  otpId,
  subjectUserId = "user-1",
  actorSource = "telegram",
  actorType = "user",
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
    scopeRestriction: null,
    scope: { kind: "org", orgId: "org-1", jurisdiction: null },
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
    causation: { kind: "origin" },
  };
};

const telegramLinkingExecution = (event: AutomationEvent) =>
  createAutomationRuntimeExecution({
    event,
    authority: {
      mode: { kind: "organization-automation", grants: [] },
      automationId: "automation:telegram-start-linking-test",
    },
  });

const telegramLinkingWorkflowRequest = (event: AutomationEvent) => ({
  path: "/workspace/telegram-channel/automations/telegram-user-linking.workflow.js",
  event,
  execution: telegramLinkingExecution(event),
});

describe("Telegram Channel OTP linking automation in memory", () => {
  test("routes Telegram /start through OTP confirmation and links the Telegram chat", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "starter telegram /start links a chat through OTP",

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
          when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 10_001,
            messageId: 501,
            chatId: "1001",
            text: "/start",
            from: { id: 1_001, firstName: "Ada", username: "ada_lovelace" },
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
              const scope = { kind: "org" as const, orgId: "org-1", jurisdiction: null };
              const binding = await ctx.runtime.objects.automations
                .for(scope)
                .commands.resolveExternalIdentity(
                  {
                    identity: {
                      scope: "external",
                      source: "telegram",
                      type: "user",
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
            text: "Your Telegram account is now linked.",
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

  test("Telegram /start in a group asks for a private chat and posts no claim link", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "starter telegram /start in a group creates no claim",
        fakes: ({ fake }) => ({ telegram: fake.telegram() }),
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({ orgId: "org-1", botUsername: "fragno_bot" }),
        ],
        steps: ({ when, then }) => [
          when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
          when.telegram.webhook({
            orgId: "org-1",
            update: {
              update_id: 10_001,
              message: {
                message_id: 501,
                date: 1_780_000_000,
                text: "/start",
                from: { id: 1_001, is_bot: false, first_name: "Ada" },
                chat: { id: -1_002_001, type: "supergroup", title: "Ada Labs team" },
              },
            },
          }),

          then.telegram.sentMessage({
            chatId: "-1002001",
            text: "Send /start to me in a private chat to link your Telegram account.",
          }),
          then.assert("assert no claim link was sent", (ctx) => {
            const calls = ctx.fakes.telegram?.sendMessageCalls ?? [];
            if (calls.length !== 1) {
              throw new Error(
                `Expected only the private-chat prompt, got ${calls.length} messages.`,
              );
            }
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-linking",
            status: "complete",
            output: { skipped: true, reason: "not-private-chat" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("starts separate Telegram user-linking workflows for separate /start event ids", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "starter telegram /start creates event-keyed linking workflows",

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
          when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 10_001,
            messageId: 501,
            chatId: "1001",
            text: "/start",
            from: { id: 1_001, firstName: "Ada", username: "ada_lovelace" },
          }),
          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 10_002,
            messageId: 502,
            chatId: "1001",
            text: "/start",
            from: { id: 1_001, firstName: "Ada", username: "ada_lovelace" },
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
        objects: scenarioObjects,
        name: "starter telegram /start resolves an already linked chat",
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
          when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
          when.workflow.createInstance({
            orgId: "org-1",
            remoteWorkflowName: "telegram-user-linking",
            instanceId: "telegram-link-already-linked",
            ...telegramLinkingWorkflowRequest(
              telegramMessageEvent({ id: "telegram:message:already-linked", text: "/start" }),
            ),
          }),

          then.telegram.sentMessage({
            chatId: "1001",
            text: "Your Telegram account is already linked.",
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
        objects: scenarioObjects,
        name: "starter OTP completion without workflow binding is ignored",

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
          when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
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

  test("telegram-user-linking rejects a completed claim with a different OTP id", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "telegram-user-linking rejects a mismatched OTP claim",

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
          when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
          when.workflow.createInstance({
            orgId: "org-1",
            remoteWorkflowName: "telegram-user-linking",
            instanceId: "telegram-link-claim-mismatch",
            ...telegramLinkingWorkflowRequest(
              telegramMessageEvent({ id: "telegram:message:claim-mismatch", text: "/start" }),
            ),
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
        objects: scenarioObjects,
        name: "telegram-user-linking claim wait times out",

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
          when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
          when.workflow.createInstance({
            orgId: "org-1",
            remoteWorkflowName: "telegram-user-linking",
            instanceId: "telegram-link-timeout",
            ...telegramLinkingWorkflowRequest(
              telegramMessageEvent({ id: "telegram:message:claim-timeout", text: "/start" }),
            ),
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
