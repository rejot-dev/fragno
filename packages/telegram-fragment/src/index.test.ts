import { beforeEach, describe, expect, test, vi } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { getInternalFragment } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import { telegramFragmentDefinition } from "./definition";
import { telegramRoutesFactory } from "./routes";
import { telegramSchema } from "./schema";
import type { TelegramUpdate } from "./types";
import { createTelegram, defineCommand } from "./types";

globalThis.fetch = vi.fn();

const webhookSecret = "secret-token";

const baseUpdate: TelegramUpdate = {
  update_id: 100,
  message: {
    message_id: 50,
    date: 1_710_000_000,
    text: "/ping hello",
    entities: [{ type: "bot_command", offset: 0, length: 5 }],
    chat: {
      id: 123,
      type: "group",
      title: "Test Chat",
    },
    from: {
      id: 42,
      is_bot: false,
      first_name: "Alice",
      last_name: "Doe",
      username: "alice",
    },
    new_chat_members: [
      {
        id: 43,
        is_bot: false,
        first_name: "Bob",
      },
    ],
  },
};

describe("telegram-fragment", async () => {
  const onMessageReceived = vi.fn();
  const onCommandMatched = vi.fn();
  const onChatMemberUpdated = vi.fn();
  const commandHandler = vi.fn();
  let sendOnCommand = false;
  let editOnCommand = false;

  const telegramConfig = createTelegram({
    botToken: "test-token",
    webhookSecretToken: webhookSecret,
    botUsername: "test_bot",
    hooks: {
      onMessageReceived,
      onCommandMatched,
      onChatMemberUpdated,
    },
  })
    .command(
      defineCommand("ping", {
        description: "Ping",
        scopes: ["private", "group", "supergroup"],
        handler: async (ctx) => {
          commandHandler(ctx.command.name);
          if (sendOnCommand) {
            await ctx.api.sendMessage({ chat_id: ctx.chat.id, text: "pong" });
          }
          if (editOnCommand) {
            await ctx.api.editMessageText({
              chat_id: ctx.chat.id,
              message_id: 60,
              text: "edited",
            });
          }
        },
      }),
    )
    .build();

  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment(
      "telegram",
      instantiate(telegramFragmentDefinition)
        .withConfig(telegramConfig)
        .withRoutes([telegramRoutesFactory]),
    )
    .build();

  const { fragment } = fragments.telegram;

  beforeEach(async () => {
    await testContext.resetDatabase();
    onMessageReceived.mockClear();
    onCommandMatched.mockClear();
    onChatMemberUpdated.mockClear();
    commandHandler.mockClear();
    sendOnCommand = false;
    editOnCommand = false;
    vi.mocked(globalThis.fetch).mockReset();
  });

  test("webhook validates secret", async () => {
    const response = await fragment.callRoute("POST", "/telegram/webhook", {
      body: baseUpdate,
    });

    expect(response.type).toBe("error");
    if (response.type === "error") {
      expect(response.error.code).toBe("UNAUTHORIZED");
    }
  });

  test("processes webhook updates and triggers hooks", async () => {
    const response = await fragment.callRoute("POST", "/telegram/webhook", {
      body: baseUpdate,
      headers: {
        "x-telegram-bot-api-secret-token": webhookSecret,
      },
    });

    expect(response.type).toBe("json");

    await drainDurableHooks(fragment);

    expect(onMessageReceived).toHaveBeenCalledTimes(1);
    expect(onCommandMatched).toHaveBeenCalledTimes(1);
    expect(onChatMemberUpdated).toHaveBeenCalledTimes(1);
    expect(commandHandler).toHaveBeenCalledWith("ping");

    const messages = await fragments.telegram.db.find("message", (b) => b.whereIndex("primary"));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.commandName).toBe("ping");
  });

  test("dedupes chat and user upserts for duplicate update entities", async () => {
    const duplicateUser = baseUpdate.message!.from!;
    const duplicateMember = baseUpdate.message!.new_chat_members![0]!;
    const duplicateUpdate: TelegramUpdate = {
      ...baseUpdate,
      update_id: 200,
      message: {
        ...baseUpdate.message!,
        message_id: 70,
        sender_chat: {
          ...baseUpdate.message!.chat,
        },
        new_chat_members: [duplicateUser, duplicateMember, duplicateMember],
        left_chat_member: duplicateUser,
      },
    };

    const response = await fragment.callRoute("POST", "/telegram/webhook", {
      body: duplicateUpdate,
      headers: {
        "x-telegram-bot-api-secret-token": webhookSecret,
      },
    });

    expect(response.type).toBe("json");

    await drainDurableHooks(fragment);

    const chats = await fragments.telegram.db.find("chat", (b) => b.whereIndex("primary"));
    expect(chats).toHaveLength(1);
    expect(chats[0]?.id.toString()).toBe("123");

    const users = await fragments.telegram.db.find("user", (b) => b.whereIndex("primary"));
    const userIds = users.map((user) => user.id.toString());
    expect(new Set(userIds).size).toBe(2);
    expect(userIds).toContain("42");
    expect(userIds).toContain("43");
  });

  test("dedupes webhook update ids", async () => {
    const response1 = await fragment.callRoute("POST", "/telegram/webhook", {
      body: baseUpdate,
      headers: {
        "x-telegram-bot-api-secret-token": webhookSecret,
      },
    });
    const response2 = await fragment.callRoute("POST", "/telegram/webhook", {
      body: baseUpdate,
      headers: {
        "x-telegram-bot-api-secret-token": webhookSecret,
      },
    });

    expect(response1.type).toBe("json");
    if (response1.type === "json") {
      expect(response1.data.ok).toBe(true);
      expect(response1.data.duplicate).toBeUndefined();
    }
    expect(response2.type).toBe("json");
    if (response2.type === "json") {
      expect(response2.data.ok).toBe(true);
      expect(response2.data.duplicate).toBe(true);
    }

    await drainDurableHooks(fragment);

    expect(commandHandler).toHaveBeenCalledTimes(1);
    const messages = await fragments.telegram.db.find("message", (b) => b.whereIndex("primary"));
    expect(messages).toHaveLength(1);
  });

  test("command bindings disable commands", async () => {
    await fragment.callRoute("POST", "/telegram/webhook", {
      body: baseUpdate,
      headers: {
        "x-telegram-bot-api-secret-token": webhookSecret,
      },
    });

    await drainDurableHooks(fragment);

    const bindResponse = await fragment.callRoute("POST", "/commands/bind", {
      body: {
        chatId: "123",
        commandName: "ping",
        enabled: false,
      },
    });

    expect(bindResponse.type).toBe("json");

    const updated = await fragment.callRoute("GET", "/commands", {
      query: { chatId: "123" },
    });

    expect(updated.type).toBe("json");
    if (updated.type === "json") {
      const command = updated.data.commands.find(
        (entry: { name: string }) => entry.name === "ping",
      );
      expect(command?.enabled).toBe(false);
    }

    const secondUpdate: TelegramUpdate = {
      ...baseUpdate,
      update_id: 101,
      message: {
        ...baseUpdate.message!,
        message_id: 51,
      },
    };

    await fragment.callRoute("POST", "/telegram/webhook", {
      body: secondUpdate,
      headers: {
        "x-telegram-bot-api-secret-token": webhookSecret,
      },
    });

    await drainDurableHooks(fragment);

    expect(commandHandler).toHaveBeenCalledTimes(1);
  });

  test("persists outgoing messages for send/edit routes", async () => {
    const sentMessage = {
      message_id: 60,
      date: 1_710_000_100,
      text: "Hello from bot",
      chat: {
        id: 123,
        type: "group",
        title: "Test Chat",
      },
      from: {
        id: 999,
        is_bot: true,
        first_name: "TestBot",
        username: "test_bot",
      },
    };

    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: sentMessage }),
    } as Response);

    const sendResponse = await fragment.callRoute("POST", "/chats/:chatId/send", {
      pathParams: { chatId: "123" },
      body: { text: "Hello from bot" },
    });

    expect(sendResponse.type).toBe("json");
    if (sendResponse.type === "json") {
      expect(sendResponse.data.ok).toBe(true);
      expect(sendResponse.data.queued).toBe(true);
    }

    await drainDurableHooks(fragment);

    const storedAfterSend = await fragments.telegram.db.find("message", (b) =>
      b.whereIndex("primary"),
    );
    expect(storedAfterSend).toHaveLength(1);
    expect(storedAfterSend[0]?.text).toBe("Hello from bot");
    expect(onMessageReceived).not.toHaveBeenCalled();

    const editedMessage = {
      ...sentMessage,
      text: "Edited text",
      edit_date: sentMessage.date + 10,
    };

    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: editedMessage }),
    } as Response);

    const editResponse = await fragment.callRoute(
      "POST",
      "/chats/:chatId/messages/:messageId/edit",
      {
        pathParams: { chatId: "123", messageId: "60" },
        body: { text: "Edited text" },
      },
    );

    expect(editResponse.type).toBe("json");
    if (editResponse.type === "json") {
      expect(editResponse.data.ok).toBe(true);
      expect(editResponse.data.queued).toBe(true);
    }

    await drainDurableHooks(fragment);

    const storedAfterEdit = await fragments.telegram.db.find("message", (b) =>
      b.whereIndex("primary"),
    );
    expect(storedAfterEdit).toHaveLength(1);
    expect(storedAfterEdit[0]?.text).toBe("Edited text");
    expect(storedAfterEdit[0]?.editedAt).not.toBeNull();
  });

  test("persists outgoing messages sent via command handler api", async () => {
    sendOnCommand = true;

    const outgoingMessage = {
      message_id: 61,
      date: baseUpdate.message!.date + 5,
      text: "pong",
      chat: baseUpdate.message!.chat,
      from: {
        id: 999,
        is_bot: true,
        first_name: "TestBot",
        username: "test_bot",
      },
    };

    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: outgoingMessage }),
    } as Response);

    const response = await fragment.callRoute("POST", "/telegram/webhook", {
      body: baseUpdate,
      headers: {
        "x-telegram-bot-api-secret-token": webhookSecret,
      },
    });

    expect(response.type).toBe("json");

    await drainDurableHooks(fragment);

    const messages = await fragments.telegram.db.find("message", (b) => b.whereIndex("primary"));
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.id.toString())).toContain("123:61");
  });

  test("batches command handler outgoing hooks into a single UOW", async () => {
    sendOnCommand = true;
    editOnCommand = true;

    const outgoingMessage = {
      message_id: 60,
      date: baseUpdate.message!.date + 5,
      text: "pong",
      chat: baseUpdate.message!.chat,
      from: {
        id: 999,
        is_bot: true,
        first_name: "TestBot",
        username: "test_bot",
      },
    };

    const editedMessage = {
      ...outgoingMessage,
      text: "edited",
      edit_date: outgoingMessage.date + 5,
    };

    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: outgoingMessage }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: editedMessage }),
      } as Response);

    const response = await fragment.callRoute("POST", "/telegram/webhook", {
      body: baseUpdate,
      headers: {
        "x-telegram-bot-api-secret-token": webhookSecret,
      },
    });

    expect(response.type).toBe("json");

    await drainDurableHooks(fragment);

    const internalFragment = getInternalFragment(testContext.adapter);
    const hooksNamespace = telegramSchema.name.replace(/-/g, "_");
    const hooks = await internalFragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () =>
            [internalFragment.services.hookService.getHooksByNamespace(hooksNamespace)] as const,
        )
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });

    const outgoingHooks = hooks.filter((hook) => hook.hookName === "internalOutgoingMessage");
    expect(outgoingHooks).toHaveLength(2);
    const nonces = new Set(outgoingHooks.map((hook) => hook.nonce));
    expect(nonces.size).toBe(1);
  });
});
