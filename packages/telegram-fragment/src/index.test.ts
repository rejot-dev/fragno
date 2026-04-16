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
  updateId: 100,
  message: {
    messageId: 50,
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
      isBot: false,
      firstName: "Alice",
      lastName: "Doe",
      username: "alice",
    },
    newChatMembers: [
      {
        id: 43,
        isBot: false,
        firstName: "Bob",
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
              messageId: 60,
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

    const messages = await (async () => {
      const uow = fragments.telegram.db
        .createUnitOfWork("read")
        .find("message", (b) => b.whereIndex("primary"));
      await uow.executeRetrieve();
      return (await uow.retrievalPhase)[0];
    })();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.commandName).toBe("ping");
  });

  test("normalizes raw Telegram webhook payloads at the boundary", async () => {
    const response = await fragment.callRoute("POST", "/telegram/webhook", {
      body: {
        update_id: 110,
        message: {
          message_id: 55,
          date: 1_710_000_010,
          text: "/ping raw",
          entities: [{ type: "bot_command", offset: 0, length: 5 }],
          chat: {
            id: 123,
            type: "private",
          },
          from: {
            id: 42,
            is_bot: false,
            first_name: "Alice",
            username: "alice",
          },
          voice: {
            file_id: "voice-file-raw-1",
            file_unique_id: "voice-unique-raw-1",
            duration: 4,
          },
        },
      },
      headers: {
        "x-telegram-bot-api-secret-token": webhookSecret,
      },
    });

    expect(response.type).toBe("json");

    await drainDurableHooks(fragment);

    expect(onMessageReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          {
            kind: "voice",
            fileId: "voice-file-raw-1",
            fileUniqueId: "voice-unique-raw-1",
            duration: 4,
          },
        ],
      }),
    );
    expect(commandHandler).toHaveBeenCalledWith("ping");
  });

  test("includes minimal attachments in message hooks and message summaries", async () => {
    const voiceUpdate: TelegramUpdate = {
      updateId: 101,
      message: {
        messageId: 51,
        date: 1_710_000_001,
        chat: {
          id: 123,
          type: "private",
        },
        from: {
          id: 42,
          isBot: false,
          firstName: "Alice",
        },
        voice: {
          fileId: "voice-file-1",
          fileUniqueId: "voice-unique-1",
          duration: 3,
        },
      },
    };

    const response = await fragment.callRoute("POST", "/telegram/webhook", {
      body: voiceUpdate,
      headers: {
        "x-telegram-bot-api-secret-token": webhookSecret,
      },
    });

    expect(response.type).toBe("json");

    await drainDurableHooks(fragment);

    expect(onMessageReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        text: null,
        attachments: [
          {
            kind: "voice",
            fileId: "voice-file-1",
            fileUniqueId: "voice-unique-1",
            duration: 3,
          },
        ],
      }),
    );

    const messages = await fragment.callRoute("GET", "/chats/:chatId/messages", {
      pathParams: { chatId: "123" },
    });

    expect(messages.type).toBe("json");
    if (messages.type === "json") {
      expect(messages.data.messages[0]?.attachments).toEqual([
        {
          kind: "voice",
          fileId: "voice-file-1",
          fileUniqueId: "voice-unique-1",
          duration: 3,
        },
      ]);
    }
  });

  test("preserves rich attachment metadata in hooks and message summaries", async () => {
    const richAttachmentUpdate: TelegramUpdate = {
      updateId: 102,
      message: {
        messageId: 52,
        date: 1_710_000_002,
        chat: {
          id: 123,
          type: "private",
        },
        from: {
          id: 42,
          isBot: false,
          firstName: "Alice",
        },
        photo: [
          {
            fileId: "photo-small-1",
            fileUniqueId: "photo-small-unique-1",
            fileSize: 256,
            width: 90,
            height: 90,
          },
          {
            fileId: "photo-large-1",
            fileUniqueId: "photo-large-unique-1",
            fileSize: 4096,
            width: 1280,
            height: 960,
          },
        ],
        audio: {
          fileId: "audio-file-1",
          fileUniqueId: "audio-unique-1",
          fileSize: 8192,
          duration: 91,
          performer: "Alice",
          title: "Voice memo",
          fileName: "voice-memo.mp3",
          mimeType: "audio/mpeg",
          thumbnail: {
            fileId: "audio-thumb-1",
            fileUniqueId: "audio-thumb-unique-1",
            fileSize: 128,
            width: 120,
            height: 120,
          },
        },
        document: {
          fileId: "document-file-1",
          fileUniqueId: "document-unique-1",
          fileSize: 2048,
          fileName: "invoice.pdf",
          mimeType: "application/pdf",
          thumbnail: {
            fileId: "document-thumb-1",
            fileUniqueId: "document-thumb-unique-1",
            fileSize: 256,
            width: 128,
            height: 180,
          },
        },
      },
    };

    const response = await fragment.callRoute("POST", "/telegram/webhook", {
      body: richAttachmentUpdate,
      headers: {
        "x-telegram-bot-api-secret-token": webhookSecret,
      },
    });

    expect(response.type).toBe("json");

    await drainDurableHooks(fragment);

    expect(onMessageReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          {
            kind: "photo",
            fileId: "photo-large-1",
            fileUniqueId: "photo-large-unique-1",
            fileSize: 4096,
            width: 1280,
            height: 960,
            thumbnail: {
              fileId: "photo-small-1",
              fileUniqueId: "photo-small-unique-1",
              fileSize: 256,
              width: 90,
              height: 90,
            },
            sizes: [
              {
                fileId: "photo-small-1",
                fileUniqueId: "photo-small-unique-1",
                fileSize: 256,
                width: 90,
                height: 90,
              },
              {
                fileId: "photo-large-1",
                fileUniqueId: "photo-large-unique-1",
                fileSize: 4096,
                width: 1280,
                height: 960,
              },
            ],
          },
          {
            kind: "audio",
            fileId: "audio-file-1",
            fileUniqueId: "audio-unique-1",
            fileSize: 8192,
            duration: 91,
            performer: "Alice",
            title: "Voice memo",
            fileName: "voice-memo.mp3",
            mimeType: "audio/mpeg",
            thumbnail: {
              fileId: "audio-thumb-1",
              fileUniqueId: "audio-thumb-unique-1",
              fileSize: 128,
              width: 120,
              height: 120,
            },
          },
          {
            kind: "document",
            fileId: "document-file-1",
            fileUniqueId: "document-unique-1",
            fileSize: 2048,
            fileName: "invoice.pdf",
            mimeType: "application/pdf",
            thumbnail: {
              fileId: "document-thumb-1",
              fileUniqueId: "document-thumb-unique-1",
              fileSize: 256,
              width: 128,
              height: 180,
            },
          },
        ],
      }),
    );

    const messages = await fragment.callRoute("GET", "/chats/:chatId/messages", {
      pathParams: { chatId: "123" },
    });

    expect(messages.type).toBe("json");
    if (messages.type === "json") {
      expect(messages.data.messages[0]?.attachments).toEqual([
        {
          kind: "photo",
          fileId: "photo-large-1",
          fileUniqueId: "photo-large-unique-1",
          fileSize: 4096,
          width: 1280,
          height: 960,
          thumbnail: {
            fileId: "photo-small-1",
            fileUniqueId: "photo-small-unique-1",
            fileSize: 256,
            width: 90,
            height: 90,
          },
          sizes: [
            {
              fileId: "photo-small-1",
              fileUniqueId: "photo-small-unique-1",
              fileSize: 256,
              width: 90,
              height: 90,
            },
            {
              fileId: "photo-large-1",
              fileUniqueId: "photo-large-unique-1",
              fileSize: 4096,
              width: 1280,
              height: 960,
            },
          ],
        },
        {
          kind: "audio",
          fileId: "audio-file-1",
          fileUniqueId: "audio-unique-1",
          fileSize: 8192,
          duration: 91,
          performer: "Alice",
          title: "Voice memo",
          fileName: "voice-memo.mp3",
          mimeType: "audio/mpeg",
          thumbnail: {
            fileId: "audio-thumb-1",
            fileUniqueId: "audio-thumb-unique-1",
            fileSize: 128,
            width: 120,
            height: 120,
          },
        },
        {
          kind: "document",
          fileId: "document-file-1",
          fileUniqueId: "document-unique-1",
          fileSize: 2048,
          fileName: "invoice.pdf",
          mimeType: "application/pdf",
          thumbnail: {
            fileId: "document-thumb-1",
            fileUniqueId: "document-thumb-unique-1",
            fileSize: 256,
            width: 128,
            height: 180,
          },
        },
      ]);
    }
  });

  test("dedupes chat and user upserts for duplicate update entities", async () => {
    const duplicateUser = baseUpdate.message!.from!;
    const duplicateMember = baseUpdate.message!.newChatMembers![0]!;
    const duplicateUpdate: TelegramUpdate = {
      ...baseUpdate,
      updateId: 200,
      message: {
        ...baseUpdate.message!,
        messageId: 70,
        senderChat: {
          ...baseUpdate.message!.chat,
        },
        newChatMembers: [duplicateUser, duplicateMember, duplicateMember],
        leftChatMember: duplicateUser,
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

    const chats = await (async () => {
      const uow = fragments.telegram.db
        .createUnitOfWork("read")
        .find("chat", (b) => b.whereIndex("primary"));
      await uow.executeRetrieve();
      return (await uow.retrievalPhase)[0];
    })();
    expect(chats).toHaveLength(1);
    expect(chats[0]?.id.toString()).toBe("123");

    const users = await (async () => {
      const uow = fragments.telegram.db
        .createUnitOfWork("read")
        .find("user", (b) => b.whereIndex("primary"));
      await uow.executeRetrieve();
      return (await uow.retrievalPhase)[0];
    })();
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
    const messages = await (async () => {
      const uow = fragments.telegram.db
        .createUnitOfWork("read")
        .find("message", (b) => b.whereIndex("primary"));
      await uow.executeRetrieve();
      return (await uow.retrievalPhase)[0];
    })();
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
      updateId: 101,
      message: {
        ...baseUpdate.message!,
        messageId: 51,
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

    const sendRequest = vi.mocked(globalThis.fetch).mock.calls[0]?.[1];
    const sendRequestBody =
      sendRequest && typeof sendRequest === "object" && "body" in sendRequest
        ? JSON.parse(String(sendRequest.body))
        : null;
    expect(sendRequestBody).toMatchObject({
      chat_id: "123",
      text: "Hello from bot",
    });
    expect(sendRequestBody).not.toHaveProperty("chatId");

    const storedAfterSend = await (async () => {
      const uow = fragments.telegram.db
        .createUnitOfWork("read")
        .find("message", (b) => b.whereIndex("primary"));
      await uow.executeRetrieve();
      return (await uow.retrievalPhase)[0];
    })();
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

    const editRequest = vi.mocked(globalThis.fetch).mock.calls[1]?.[1];
    const editRequestBody =
      editRequest && typeof editRequest === "object" && "body" in editRequest
        ? JSON.parse(String(editRequest.body))
        : null;
    expect(editRequestBody).toMatchObject({
      chat_id: "123",
      message_id: 60,
      text: "Edited text",
    });
    expect(editRequestBody).not.toHaveProperty("chatId");
    expect(editRequestBody).not.toHaveProperty("messageId");

    const storedAfterEdit = await (async () => {
      const uow = fragments.telegram.db
        .createUnitOfWork("read")
        .find("message", (b) => b.whereIndex("primary"));
      await uow.executeRetrieve();
      return (await uow.retrievalPhase)[0];
    })();
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

    const messages = await (async () => {
      const uow = fragments.telegram.db
        .createUnitOfWork("read")
        .find("message", (b) => b.whereIndex("primary"));
      await uow.executeRetrieve();
      return (await uow.retrievalPhase)[0];
    })();
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
