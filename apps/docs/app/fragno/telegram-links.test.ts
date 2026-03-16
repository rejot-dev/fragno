import { describe, expect, test } from "vitest";

import {
  getTelegramLinkByAuthUserId,
  getTelegramLinkByChatId,
  getTelegramLinkByTelegramUserId,
  storeTelegramUserLink,
} from "./telegram-links";

const createStorage = () => {
  const store = new Map<string, unknown>();

  return {
    get: async <T>(key: string) => (store.get(key) as T | undefined) ?? undefined,
    put: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
      return true;
    },
  } as unknown as Pick<DurableObjectStorage, "get" | "put" | "delete">;
};

describe("telegram link storage", () => {
  test("stores lookups by telegram user, auth user, and chat", async () => {
    const storage = createStorage();

    await storeTelegramUserLink(storage, {
      orgId: "org_1",
      authUserId: "user_1",
      telegramUserId: "tg_1",
      chatId: "chat_1",
      linkedAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
      telegramUsername: "alice",
      telegramFirstName: "Alice",
      telegramLastName: null,
      chatTitle: "Alice DM",
    });

    await expect(getTelegramLinkByTelegramUserId(storage, "tg_1")).resolves.toMatchObject({
      authUserId: "user_1",
      chatId: "chat_1",
    });
    await expect(getTelegramLinkByAuthUserId(storage, "user_1")).resolves.toMatchObject({
      telegramUserId: "tg_1",
      chatId: "chat_1",
    });
    await expect(getTelegramLinkByChatId(storage, "chat_1")).resolves.toMatchObject({
      authUserId: "user_1",
      telegramUserId: "tg_1",
    });
  });

  test("replaces stale reverse indexes when a user is re-linked", async () => {
    const storage = createStorage();

    await storeTelegramUserLink(storage, {
      orgId: "org_1",
      authUserId: "user_1",
      telegramUserId: "tg_old",
      chatId: "chat_old",
      linkedAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
      telegramUsername: "old",
      telegramFirstName: "Old",
      telegramLastName: null,
      chatTitle: "Old DM",
    });

    await storeTelegramUserLink(storage, {
      orgId: "org_1",
      authUserId: "user_1",
      telegramUserId: "tg_new",
      chatId: "chat_new",
      linkedAt: "2026-03-15T01:00:00.000Z",
      updatedAt: "2026-03-15T01:00:00.000Z",
      telegramUsername: "new",
      telegramFirstName: "New",
      telegramLastName: null,
      chatTitle: "New DM",
    });

    await expect(getTelegramLinkByTelegramUserId(storage, "tg_old")).resolves.toBeNull();
    await expect(getTelegramLinkByChatId(storage, "chat_old")).resolves.toBeNull();
    await expect(getTelegramLinkByAuthUserId(storage, "user_1")).resolves.toMatchObject({
      telegramUserId: "tg_new",
      chatId: "chat_new",
      linkedAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T01:00:00.000Z",
    });
  });
});
