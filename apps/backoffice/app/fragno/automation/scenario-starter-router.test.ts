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

describe("starter automation router scenarios", () => {
  test("pi capability.configured stores the default Pi agent", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter router stores the default Pi agent",

        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          when.capability.configured.pi({
            orgId: "org-1",
            harnessId: "default",
            harnessLabel: "Default",
            harnessTools: ["bash"],
            modelProvider: "openai",
            modelName: "gpt-5-mini",
            modelLabel: "GPT-5 mini",
          }),

          then.store.entry({
            orgId: "org-1",
            key: "pi/pi-default-agent",
            value: "default::openai::gpt-5-mini",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("Telegram /pi creates a Pi session for a linked chat", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter Telegram /pi creates a Pi session",

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
          when.capability.configured.pi({
            orgId: "org-1",
            harnessId: "default",
            modelProvider: "openai",
            modelName: "gpt-5-mini",
          }),

          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_001,
            messageId: 601,
            chatId: "1001",
            text: "/pi",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.pi.createdSession({
            agent: "default::openai::gpt-5-mini",
            name: "Telegram 1001",
            sessionId: "pi-session-1",
          }),
          then.store.entry({
            orgId: "org-1",
            key: "telegram-pi-session/user-1",
            value: "pi-session-1",
          }),
          then.telegram.sentMessage({
            chatId: "1001",
            text: "Created Pi session: pi-session-1",
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-pi-linking",
            status: "complete",
            output: { sessionId: "pi-session-1" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("Telegram /pi skips a linked chat when no default Pi agent is stored", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter Telegram /pi skips without a default Pi agent",

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
          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_004,
            messageId: 604,
            chatId: "1001",
            text: "/pi",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.telegram.noMessages(),
          then.assert("assert Pi was not called", (ctx) => {
            const calls = ctx.fakes.pi?.createSessionCalls ?? [];
            if (calls.length !== 0) {
              throw new Error(`Expected no Pi session creation, got ${calls.length}.`);
            }
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-pi-linking",
            status: "complete",
            output: { skipped: true, reason: "missing-default-agent" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("Telegram /pi skips an unlinked chat", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter Telegram /pi skips an unlinked chat",

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
          given.pi.defaultAgent({
            orgId: "org-1",
            value: "default::openai::gpt-5-mini",
          }),
        ],

        steps: ({ when, then }) => [
          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_006,
            messageId: 606,
            chatId: "1001",
            text: "/pi",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.telegram.noMessages(),
          then.assert("assert Pi was not called", (ctx) => {
            const calls = ctx.fakes.pi?.createSessionCalls ?? [];
            if (calls.length !== 0) {
              throw new Error(`Expected no Pi session creation, got ${calls.length}.`);
            }
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-pi-linking",
            status: "complete",
            output: { skipped: true, reason: "telegram-chat-not-linked" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("Telegram text skips an unlinked chat", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter Telegram text skips an unlinked chat",

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
          given.pi.defaultAgent({
            orgId: "org-1",
            value: "default::openai::gpt-5-mini",
          }),
        ],

        steps: ({ when, then }) => [
          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_007,
            messageId: 607,
            chatId: "1001",
            text: "Hello Pi",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.telegram.noMessages(),
          then.assert("assert Pi was not called", (ctx) => {
            const calls = ctx.fakes.pi?.createSessionCalls ?? [];
            if (calls.length !== 0) {
              throw new Error(`Expected no Pi session creation, got ${calls.length}.`);
            }
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-pi-linking",
            status: "complete",
            output: { skipped: true, reason: "telegram-chat-not-linked" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("Telegram unrelated slash commands do not create starter workflows", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter Telegram slash command is ignored",

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
          given.pi.defaultAgent({
            orgId: "org-1",
            value: "default::openai::gpt-5-mini",
          }),
        ],

        steps: ({ when, then }) => [
          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_008,
            messageId: 608,
            chatId: "1001",
            text: "/help",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.telegram.noMessages(),
          then.workflow.missing({ remoteWorkflowName: "telegram-user-linking" }),
          then.workflow.missing({ remoteWorkflowName: "telegram-test-command" }),
          then.workflow.missing({ remoteWorkflowName: "telegram-user-pi-linking" }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("raw Telegram webhooks without messages do not create starter workflows", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter raw Telegram webhook without message is ignored",

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
          when.telegram.webhook({
            orgId: "org-1",
            label: "receive Telegram webhook without a message",
            update: {
              update_id: 21_001,
              my_chat_member: {
                chat: { id: 1001, type: "private" },
                from: { id: 2001, is_bot: false, first_name: "Ada" },
                date: 1_780_000_000,
                old_chat_member: { status: "member", user: { id: 123, is_bot: true } },
                new_chat_member: { status: "kicked", user: { id: 123, is_bot: true } },
              },
            },
          }),

          then.telegram.noMessages(),
          then.workflow.missing({ remoteWorkflowName: "telegram-user-linking" }),
          then.workflow.missing({ remoteWorkflowName: "telegram-test-command" }),
          then.workflow.missing({ remoteWorkflowName: "telegram-user-pi-linking" }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("telegram-user-pi-linking skips slash commands other than /pi", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "telegram-user-pi-linking skips unrelated slash commands",

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
        ],

        steps: ({ when, then }) => [
          when.workflow.createInstance({
            orgId: "org-1",
            remoteWorkflowName: "telegram-user-pi-linking",
            instanceId: "telegram-pi-unrelated-command",
            params: {
              automationEvent: telegramMessageEvent({
                id: "telegram:message:unrelated-pi-command",
                text: "/help",
              }),
              workflowScriptPath: "/workspace/automations/telegram-user-pi-linking.workflow.js",
            },
          }),

          then.telegram.noMessages(),
          then.assert("assert Pi was not called", (ctx) => {
            const calls = ctx.fakes.pi?.createSessionCalls ?? [];
            if (calls.length !== 0) {
              throw new Error(`Expected no Pi session creation, got ${calls.length}.`);
            }
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-pi-linking",
            instanceId: "telegram-pi-unrelated-command",
            status: "complete",
            output: { skipped: true, reason: "not-telegram-pi-message" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("Telegram text reuses a Pi session and forwards assistant text", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter Telegram text reuses a Pi session",

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
          given.pi.defaultAgent({
            orgId: "org-1",
            value: "default::openai::gpt-5-mini",
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
            updateId: 20_002,
            messageId: 602,
            chatId: "1001",
            text: "/pi",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_003,
            messageId: 603,
            chatId: "1001",
            text: "Hello Pi",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.pi.createdSession({
            agent: "default::openai::gpt-5-mini",
            name: "Telegram 1001",
            sessionId: "pi-session-1",
          }),
          then.assert("assert Pi session was reused", (ctx) => {
            const calls = ctx.fakes.pi?.createSessionCalls ?? [];
            if (calls.length !== 1) {
              throw new Error(`Expected one Pi session creation, got ${calls.length}.`);
            }
          }),
          then.store.entries({
            orgId: "org-1",
            prefix: "telegram",
            include: [
              { key: "telegram/1001", value: "user-1" },
              { key: "telegram-pi-session/user-1", value: "pi-session-1" },
            ],
          }),
          then.telegram.sentChatAction({
            chatId: "1001",
            action: "typing",
          }),
          then.pi.ranTurn({
            sessionId: "pi-session-1",
            text: "Hello Pi",
            assistantText: "agent:Hello Pi",
          }),
          then.telegram.sentMessage({
            chatId: "1001",
            text: "agent:Hello Pi",
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-pi-linking",
            status: "complete",
            output: { sessionId: "pi-session-1" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("Telegram /pi reuses an active stored Pi session", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter Telegram /pi reuses an active Pi session",

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
          given.pi.defaultAgent({
            orgId: "org-1",
            value: "default::openai::gpt-5-mini",
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
            updateId: 20_009,
            messageId: 609,
            chatId: "1001",
            text: "/pi",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_010,
            messageId: 610,
            chatId: "1001",
            text: "/pi",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.assert("assert Pi session creation was reused", (ctx) => {
            const calls = ctx.fakes.pi?.createSessionCalls ?? [];
            if (calls.length !== 1) {
              throw new Error(`Expected one Pi session creation, got ${calls.length}.`);
            }
          }),
          then.telegram.sentMessage({
            chatId: "1001",
            text: "Created Pi session: pi-session-1",
          }),
          then.telegram.sentMessage({
            chatId: "1001",
            text: "Pi session: pi-session-1",
          }),
          then.store.entry({
            orgId: "org-1",
            key: "telegram-pi-session/user-1",
            value: "pi-session-1",
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-pi-linking",
            status: "complete",
            output: { sessionId: "pi-session-1" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("Telegram /pi replaces a missing stored Pi session", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter Telegram /pi replaces a missing stored Pi session",

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
          given.pi.defaultAgent({
            orgId: "org-1",
            value: "default::openai::gpt-5-mini",
          }),
          given.store.entry({
            orgId: "org-1",
            key: "telegram/1001",
            value: "user-1",
          }),
          given.store.entry({
            orgId: "org-1",
            key: "telegram-pi-session/user-1",
            value: "pi-session-missing",
          }),
        ],

        steps: ({ when, then }) => [
          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_011,
            messageId: 611,
            chatId: "1001",
            text: "/pi",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.assert("assert missing Pi session was checked", (ctx) => {
            const calls = ctx.fakes.pi?.getSessionCalls ?? [];
            if (!calls.some((call) => call.sessionId === "pi-session-missing")) {
              throw new Error(`Expected missing Pi session lookup, got ${JSON.stringify(calls)}.`);
            }
          }),
          then.pi.createdSession({
            agent: "default::openai::gpt-5-mini",
            name: "Telegram 1001",
            sessionId: "pi-session-1",
          }),
          then.store.entry({
            orgId: "org-1",
            key: "telegram-pi-session/user-1",
            value: "pi-session-1",
          }),
          then.telegram.sentMessage({
            chatId: "1001",
            text: "Created Pi session: pi-session-1",
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-pi-linking",
            status: "complete",
            output: { sessionId: "pi-session-1" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test.each(["terminated", "complete", "errored"] as const)(
    "Telegram /pi replaces a %s stored Pi session",
    async (status) => {
      await runBackofficeScenario(
        defineBackofficeScenario({
          name: `starter Telegram /pi replaces a ${status} Pi session`,

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
            given.pi.defaultAgent({
              orgId: "org-1",
              value: "default::openai::gpt-5-mini",
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
              updateId: `terminal-${status}-1`,
              messageId: 612,
              chatId: "1001",
              text: "/pi",
              from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
            }),

            then.assert(`mark Pi session ${status}`, (ctx) => {
              ctx.fakes.pi?.setSessionStatus("pi-session-1", status);
            }),

            when.telegram.receivesMessage({
              orgId: "org-1",
              updateId: `terminal-${status}-2`,
              messageId: 613,
              chatId: "1001",
              text: "/pi",
              from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
            }),

            then.assert("assert replacement Pi session was created", (ctx) => {
              const calls = ctx.fakes.pi?.createSessionCalls ?? [];
              if (calls.length !== 2) {
                throw new Error(`Expected two Pi session creations, got ${calls.length}.`);
              }
            }),
            then.store.entry({
              orgId: "org-1",
              key: "telegram-pi-session/user-1",
              value: "pi-session-2",
            }),
            then.telegram.sentMessage({
              chatId: "1001",
              text: "Created Pi session: pi-session-2",
            }),
            then.workflow.instance({
              remoteWorkflowName: "telegram-user-pi-linking",
              status: "complete",
              output: { sessionId: "pi-session-2" },
            }),
            then.workflow.noErrored({ orgId: "org-1" }),
          ],
        }),
      );
    },
  );

  test("Telegram text with no Pi assistant text sends no response message", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter Telegram text sends no message when Pi has no assistant text",

        files: backofficeFiles.workspaceStarter(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
          pi: fake.pi({ assistantText: () => "" }),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.pi.defaultAgent({
            orgId: "org-1",
            value: "default::openai::gpt-5-mini",
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
            updateId: 20_014,
            messageId: 614,
            chatId: "1001",
            text: "/pi",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_015,
            messageId: 615,
            chatId: "1001",
            text: "No response expected",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.telegram.sentChatAction({
            chatId: "1001",
            action: "typing",
          }),
          then.pi.ranTurn({
            sessionId: "pi-session-1",
            text: "No response expected",
            assistantText: "",
          }),
          then.assert("assert only the Pi creation message was sent", (ctx) => {
            const calls = ctx.fakes.telegram?.sendMessageCalls ?? [];
            if (calls.length !== 1) {
              throw new Error(`Expected one Telegram message, got ${calls.length}.`);
            }
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-pi-linking",
            status: "complete",
            output: { sessionId: "pi-session-1" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("Telegram /test sends the delayed reply after time advances", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter Telegram /test waits before sending a reply",

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
            updateId: 20_005,
            messageId: 605,
            chatId: "1001",
            text: "/test",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.telegram.noMessages(),
          then.workflow.instance({
            remoteWorkflowName: "telegram-test-command",
            status: "waiting",
          }),
          then.workflow.steps({
            remoteWorkflowName: "telegram-test-command",
            include: ["wait 3 seconds"],
          }),

          when.time.advance("3 seconds"),

          then.telegram.sentMessage({
            chatId: "1001",
            text: "Delayed /test reply after 3 seconds.",
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-test-command",
            status: "complete",
            output: { sent: true },
          }),
          then.workflow.steps({
            remoteWorkflowName: "telegram-test-command",
            include: ["wait 3 seconds", "send delayed test reply"],
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("telegram-test-command skips non-/test events", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "telegram-test-command skips non-test Telegram events",

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
            remoteWorkflowName: "telegram-test-command",
            instanceId: "telegram-test-non-test-command",
            params: {
              automationEvent: telegramMessageEvent({
                id: "telegram:message:non-test-command",
                text: "/start",
              }),
              workflowScriptPath: "/workspace/automations/telegram-test-command.workflow.js",
            },
          }),

          then.telegram.noMessages(),
          then.workflow.instance({
            remoteWorkflowName: "telegram-test-command",
            instanceId: "telegram-test-non-test-command",
            status: "complete",
            output: { skipped: true, reason: "not-test-command" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });
});
