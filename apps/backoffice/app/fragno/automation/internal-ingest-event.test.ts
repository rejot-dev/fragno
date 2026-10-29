import { describe, test, vi } from "vitest";

import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";

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
import { TelegramObject } from "../../../workers/telegram-object";
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
  PI_MANAGER: allLocalObjects.PI_MANAGER,
  RESEND: (input) => new ResendObject(input),
  TELEGRAM: (input) => new TelegramObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

const TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION = {
  targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
  slug: "telegram-channel",
  version: "2.1.1",
  installationRoot: "/workspace",
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
    type: "chat",
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
      fromUserId: null,
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

describe("automation internal ingest scenarios", () => {
  test("accepts a repeated event id without dispatching duplicate workflow work", async () => {
    const event = telegramMessageEvent({ id: "duplicate-event-1", text: "/pi" });

    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "duplicate automation event ingestion is idempotent",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ when, then }) => [
          when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
          when.automation.ingestEvent(event),
          when.automation.ingestEvent(event),
          then.workflow.missing({
            remoteWorkflowName: "telegram-user-pi-linking",
            instanceId: "telegram-pi-duplicate-event-1",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("does not call Pi when the Telegram chat is not linked", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "Telegram Channel skips Pi calls for an unlinked chat",

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
          pi: fake.pi(),
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
          when.automation.ingestEvent(
            telegramMessageEvent({ id: "starter-telegram-pi-1", text: "/pi" }),
          ),
          when.automation.ingestEvent(
            telegramMessageEvent({ id: "starter-telegram-pi-2", text: "Hello Pi" }),
          ),

          then.telegram.noMessages(),
          then.assert("assert Pi was not called by legacy scripts", (ctx) => {
            const provisionedAgents = ctx.fakes.pi?.provisionedAgents ?? [];
            const turns = ctx.fakes.pi?.turns ?? [];
            if (provisionedAgents.length !== 0 || turns.length !== 0) {
              throw new Error(
                `Expected no Pi calls, got provisioned=${provisionedAgents.length}, turn=${turns.length}.`,
              );
            }
          }),
          then.workflow.missing({
            remoteWorkflowName: "telegram-user-pi-linking",
            instanceId: "telegram-pi-starter-telegram-pi-1",
          }),
          then.workflow.missing({
            remoteWorkflowName: "telegram-user-pi-linking",
            instanceId: "telegram-pi-starter-telegram-pi-2",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });
});
