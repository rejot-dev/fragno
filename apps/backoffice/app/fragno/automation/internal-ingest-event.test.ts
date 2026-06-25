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
    actor,
    actors: [actor],
    subject: { orgId: "org-1" },
  };
};

describe("automation internal ingest scenarios", () => {
  test("does not run the disabled starter Telegram Pi automation script", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter Telegram Pi legacy bash script stays disabled",

        files: backofficeFiles.workspaceStarter(),

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
          given.store.entry({
            orgId: "org-1",
            key: "telegram/1001",
            value: "user-1",
          }),
        ],

        steps: ({ when, then }) => [
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
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-pi-linking",
            instanceId: "telegram-pi-starter-telegram-pi-1",
            status: "complete",
            output: { skipped: true, reason: "missing-default-agent" },
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-pi-linking",
            instanceId: "telegram-pi-starter-telegram-pi-2",
            status: "complete",
            output: { skipped: true, reason: "missing-default-agent" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });
});
