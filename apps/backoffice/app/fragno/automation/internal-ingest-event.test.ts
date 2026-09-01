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

import { defineBackofficeScenario, runBackofficeScenario } from "./scenario";

const TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION = {
  targetScope: { kind: "org", orgId: "org-1" },
  slug: "telegram-channel",
  version: "1.0.1",
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
    scope: { kind: "org", orgId: "org-1" },
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
    subject: { orgId: "org-1" },
  };
};

describe("automation internal ingest scenarios", () => {
  test("accepts a repeated event id without dispatching duplicate workflow work", async () => {
    const event = telegramMessageEvent({ id: "duplicate-event-1", text: "/pi" });

    await runBackofficeScenario(
      defineBackofficeScenario({
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
            const createSessionCalls = ctx.fakes.pi?.createSessionCalls ?? [];
            const runTurnCalls = ctx.fakes.pi?.runTurnCalls ?? [];
            if (createSessionCalls.length !== 0 || runTurnCalls.length !== 0) {
              throw new Error(
                `Expected no Pi calls, got create=${createSessionCalls.length}, turn=${runTurnCalls.length}.`,
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
