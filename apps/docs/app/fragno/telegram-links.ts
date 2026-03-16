export type TelegramUserLinkRecord = {
  orgId: string;
  authUserId: string;
  telegramUserId: string;
  chatId: string;
  linkedAt: string;
  updatedAt: string;
  telegramUsername: string | null;
  telegramFirstName: string | null;
  telegramLastName: string | null;
  chatTitle: string | null;
};

type LinkStorage = Pick<DurableObjectStorage, "get" | "put" | "delete">;

const BY_TELEGRAM_USER_PREFIX = "telegram-link:user:";
const BY_AUTH_USER_PREFIX = "telegram-link:auth:";
const BY_CHAT_PREFIX = "telegram-link:chat:";

export const telegramLinkByTelegramUserKey = (telegramUserId: string) =>
  `${BY_TELEGRAM_USER_PREFIX}${telegramUserId}`;

export const telegramLinkByAuthUserKey = (authUserId: string) =>
  `${BY_AUTH_USER_PREFIX}${authUserId}`;

export const telegramLinkByChatKey = (chatId: string) => `${BY_CHAT_PREFIX}${chatId}`;

export async function getTelegramLinkByTelegramUserId(
  storage: LinkStorage,
  telegramUserId: string,
): Promise<TelegramUserLinkRecord | null> {
  const result = await storage.get<TelegramUserLinkRecord>(
    telegramLinkByTelegramUserKey(telegramUserId),
  );
  return result ?? null;
}

export async function getTelegramLinkByAuthUserId(
  storage: LinkStorage,
  authUserId: string,
): Promise<TelegramUserLinkRecord | null> {
  const result = await storage.get<TelegramUserLinkRecord>(telegramLinkByAuthUserKey(authUserId));
  return result ?? null;
}

export async function getTelegramLinkByChatId(
  storage: LinkStorage,
  chatId: string,
): Promise<TelegramUserLinkRecord | null> {
  const result = await storage.get<TelegramUserLinkRecord>(telegramLinkByChatKey(chatId));
  return result ?? null;
}

export async function storeTelegramUserLink(
  storage: LinkStorage,
  record: TelegramUserLinkRecord,
): Promise<TelegramUserLinkRecord> {
  const existingByTelegramUser = await getTelegramLinkByTelegramUserId(
    storage,
    record.telegramUserId,
  );
  const existingByAuthUser = await getTelegramLinkByAuthUserId(storage, record.authUserId);

  const nextRecord: TelegramUserLinkRecord = {
    ...record,
    linkedAt: existingByTelegramUser?.linkedAt ?? existingByAuthUser?.linkedAt ?? record.linkedAt,
  };

  if (
    existingByTelegramUser &&
    existingByTelegramUser.authUserId &&
    existingByTelegramUser.authUserId !== record.authUserId
  ) {
    await storage.delete(telegramLinkByAuthUserKey(existingByTelegramUser.authUserId));
    await storage.delete(telegramLinkByChatKey(existingByTelegramUser.chatId));
  }

  if (
    existingByAuthUser &&
    existingByAuthUser.telegramUserId &&
    existingByAuthUser.telegramUserId !== record.telegramUserId
  ) {
    await storage.delete(telegramLinkByTelegramUserKey(existingByAuthUser.telegramUserId));
    await storage.delete(telegramLinkByChatKey(existingByAuthUser.chatId));
  }

  await storage.put(telegramLinkByTelegramUserKey(record.telegramUserId), nextRecord);
  await storage.put(telegramLinkByAuthUserKey(record.authUserId), nextRecord);
  await storage.put(telegramLinkByChatKey(record.chatId), nextRecord);

  return nextRecord;
}
