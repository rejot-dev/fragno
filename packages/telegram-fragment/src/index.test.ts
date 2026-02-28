import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";
import { telegramFragmentDefinition } from "./definition";
import { telegramRoutesFactory } from "./routes";
import type { TelegramUpdate } from "./types";
import { createTelegram, defineCommand } from "./types";

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
});
