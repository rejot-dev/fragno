import { type Cursor, type DatabaseServiceContext } from "@fragno-dev/db";
import { FragnoId, FragnoReference } from "@fragno-dev/db/schema";
import type { TypedUnitOfWork } from "@fragno-dev/db/unit-of-work";
import { telegramSchema } from "./schema";
import {
  telegramMessageSchema,
  type TelegramChatMemberHookPayload,
  type TelegramChatMemberSummary,
  type TelegramChatSummary,
  type TelegramCommandScope,
  type TelegramFragmentConfig,
  type TelegramHooksMap,
  type TelegramMessageHookPayload,
  type TelegramMessageSummary,
  type TelegramUpdate,
  type TelegramUserSummary,
} from "./types";
import {
  DEFAULT_COMMAND_SCOPES,
  buildChatMemberId,
  buildMessageId,
  parseCommand,
  parseCommandBindings,
  parseTelegramUpdate,
} from "./telegram-utils";

const missingId = "__missing__";

type RecordId = string | FragnoId;
type RecordRef = string | FragnoId | FragnoReference;

type TelegramUserRecord = {
  id: RecordId;
  username: string | null;
  firstName: string;
  lastName: string | null;
  isBot: boolean;
  languageCode: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type TelegramChatRecord = {
  id: RecordId;
  type: string;
  title: string | null;
  username: string | null;
  isForum: boolean;
  commandBindings: unknown | null;
  createdAt: Date;
  updatedAt: Date;
};

type TelegramChatMemberRecord = {
  id: RecordId;
  chatId: RecordRef;
  userId: RecordRef;
  status: string;
  joinedAt: Date | null;
  leftAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  chatMemberUser?: TelegramUserRecord | null;
};

type TelegramMessageRecord = {
  id: RecordId;
  chatId: RecordRef;
  fromUserId: RecordRef | null;
  senderChatId: RecordRef | null;
  replyToMessageId: RecordRef | null;
  messageType: string;
  text: string | null;
  payload: unknown | null;
  sentAt: Date;
  editedAt: Date | null;
  commandName: string | null;
  messageAuthor?: TelegramUserRecord | null;
};

const parseCompositeId = (value: RecordId) => {
  const raw = String(value.valueOf());
  const [first, second] = raw.split(":");

  return {
    first: first ?? raw,
    second: second ?? null,
  };
};

const parseChatMemberCompositeId = (value: RecordId) => {
  const { first, second } = parseCompositeId(value);

  return {
    chatId: first,
    userId: second ?? "",
  };
};

const parseMessageCompositeId = (value: RecordId) => {
  const { first, second } = parseCompositeId(value);

  return {
    chatId: first,
    messageId: second ?? "",
  };
};

const parseTelegramMessagePayload = (payload: unknown) => {
  const result = telegramMessageSchema.safeParse(payload);
  return result.success ? result.data : null;
};

const toUserSummary = (user: TelegramUserRecord): TelegramUserSummary => ({
  id: String(user.id.valueOf()),
  username: user.username,
  firstName: user.firstName,
  lastName: user.lastName,
  isBot: user.isBot,
  languageCode: user.languageCode,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

const toChatSummary = (chat: TelegramChatRecord): TelegramChatSummary => ({
  id: String(chat.id.valueOf()),
  type: chat.type as TelegramChatSummary["type"],
  title: chat.title,
  username: chat.username,
  isForum: chat.isForum,
  commandBindings: chat.commandBindings ? parseCommandBindings(chat.commandBindings) : null,
  createdAt: chat.createdAt,
  updatedAt: chat.updatedAt,
});

const toChatMemberSummary = (member: TelegramChatMemberRecord): TelegramChatMemberSummary => {
  const composite = parseChatMemberCompositeId(member.id);
  const userId = member.chatMemberUser
    ? String(member.chatMemberUser.id.valueOf())
    : composite.userId;

  return {
    id: String(member.id.valueOf()),
    chatId: composite.chatId,
    userId,
    status: member.status,
    joinedAt: member.joinedAt,
    leftAt: member.leftAt,
    user: member.chatMemberUser ? toUserSummary(member.chatMemberUser) : null,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
  };
};

const toMessageSummary = (message: TelegramMessageRecord): TelegramMessageSummary => {
  const composite = parseMessageCompositeId(message.id);
  const payload = parseTelegramMessagePayload(message.payload);
  const chatId = payload?.chat ? String(payload.chat.id) : composite.chatId;
  const fromUserId = payload?.from
    ? String(payload.from.id)
    : message.messageAuthor
      ? String(message.messageAuthor.id.valueOf())
      : null;
  const senderChatId = payload?.sender_chat ? String(payload.sender_chat.id) : null;
  const replyToMessageId = payload?.reply_to_message
    ? buildMessageId(chatId, payload.reply_to_message.message_id)
    : null;

  return {
    id: String(message.id.valueOf()),
    chatId,
    fromUserId,
    senderChatId,
    replyToMessageId,
    messageType: message.messageType as TelegramMessageSummary["messageType"],
    text: message.text,
    payload: message.payload,
    sentAt: message.sentAt,
    editedAt: message.editedAt,
    commandName: message.commandName,
    fromUser: message.messageAuthor ? toUserSummary(message.messageAuthor) : null,
  };
};

export type ProcessIncomingUpdateResult =
  | { kind: "ignored"; updateId: number }
  | {
      kind: "message";
      updateId: number;
      updateType: TelegramMessageSummary["messageType"];
      chat: TelegramChatSummary;
      message: TelegramMessageSummary;
      fromUser: TelegramUserSummary | null;
      command: {
        name: string;
        args: string;
        raw: string;
        scopes: TelegramCommandScope[];
      } | null;
    };

type ProcessIncomingUpdateRetrieveResult = [
  TelegramChatRecord[],
  TelegramUserRecord[],
  TelegramChatMemberRecord[],
  TelegramMessageRecord | null,
];

type TelegramBaseUow = TypedUnitOfWork<typeof telegramSchema, [], unknown, TelegramHooksMap>;
type TelegramProcessUow = TypedUnitOfWork<
  typeof telegramSchema,
  ProcessIncomingUpdateRetrieveResult,
  unknown,
  TelegramHooksMap
>;

export type ProcessIncomingUpdateOps =
  | { kind: "ignored"; updateId: number }
  | {
      kind: "message";
      updateId: number;
      retrieve: (uow: TelegramBaseUow) => TelegramProcessUow;
      mutate: (input: {
        uow: TelegramBaseUow;
        retrieveResult: ProcessIncomingUpdateRetrieveResult;
      }) => ProcessIncomingUpdateResult;
    };

export const createProcessIncomingUpdateOps = (config: TelegramFragmentConfig) => {
  const commands = config.commands ?? {};
  const botUsername = config.botUsername;

  const resolveCommandScopes = (
    commandName: string,
    chatType: TelegramChatSummary["type"],
    bindings: ReturnType<typeof parseCommandBindings>,
  ) => {
    const definition = commands[commandName];
    if (!definition) {
      return null;
    }

    const binding = bindings[commandName];
    const enabled = binding ? binding.enabled !== false : true;
    const scopes = binding?.scopes ?? definition.scopes ?? DEFAULT_COMMAND_SCOPES;

    if (!enabled || !scopes.includes(chatType)) {
      return null;
    }

    return {
      scopes,
    };
  };

  return (update: TelegramUpdate): ProcessIncomingUpdateOps => {
    const parsed = parseTelegramUpdate(update);
    if (!parsed) {
      return {
        kind: "ignored",
        updateId: update.update_id,
      };
    }

    const { message, type, updateId } = parsed;
    const chatId = String(message.chat.id);
    const messageId = buildMessageId(chatId, message.message_id);
    const sentAt = new Date(message.date * 1000);
    const editedAt = message.edit_date ? new Date(message.edit_date * 1000) : null;
    const fromUser = message.from ?? null;
    const fromUserId = fromUser ? String(fromUser.id) : null;
    const senderChat = message.sender_chat ?? null;
    const senderChatId = senderChat ? String(senderChat.id) : null;
    const replyToMessageId = message.reply_to_message
      ? buildMessageId(chatId, message.reply_to_message.message_id)
      : null;

    const commandMatch = parseCommand(message, botUsername);
    const commandName = commandMatch?.name ?? null;

    const membershipMap = new Map<
      string,
      { status: string; joinedAt: Date | null; leftAt: Date | null; notify: boolean }
    >();

    const newMembers = message.new_chat_members ?? [];
    for (const member of newMembers) {
      membershipMap.set(String(member.id), {
        status: "member",
        joinedAt: sentAt,
        leftAt: null,
        notify: true,
      });
    }

    if (message.left_chat_member) {
      membershipMap.set(String(message.left_chat_member.id), {
        status: "left",
        joinedAt: null,
        leftAt: sentAt,
        notify: true,
      });
    }

    if (fromUserId && message.chat.type !== "channel" && !membershipMap.has(fromUserId)) {
      membershipMap.set(fromUserId, {
        status: "member",
        joinedAt: sentAt,
        leftAt: null,
        notify: false,
      });
    }

    const chatIds = Array.from(
      new Set([chatId, senderChatId ? String(senderChatId) : null].filter(Boolean) as string[]),
    );

    const userIds = Array.from(
      new Set(
        [
          fromUserId,
          ...newMembers.map((member) => String(member.id)),
          message.left_chat_member ? String(message.left_chat_member.id) : null,
        ].filter(Boolean) as string[],
      ),
    );

    const memberIds = Array.from(
      new Set(Array.from(membershipMap.keys()).map((userId) => buildChatMemberId(chatId, userId))),
    );

    const chatsForUpsert = [message.chat, senderChat].filter(Boolean) as Array<typeof message.chat>;

    const usersForUpsert = [fromUser, ...newMembers, message.left_chat_member]
      .filter(Boolean)
      .map((user) => user as NonNullable<typeof fromUser>);

    return {
      kind: "message",
      updateId,
      retrieve: (uow) =>
        uow
          .find("chat", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "in", chatIds.length ? chatIds : [missingId])),
          )
          .find("user", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "in", userIds.length ? userIds : [missingId])),
          )
          .find("chatMember", (b) =>
            b.whereIndex("primary", (eb) =>
              eb("id", "in", memberIds.length ? memberIds : [missingId]),
            ),
          )
          .findFirst("message", (b) => b.whereIndex("primary", (eb) => eb("id", "=", messageId))),
      mutate: ({
        uow,
        retrieveResult: [existingChats, existingUsers, existingMembers, existingMessage],
      }) => {
        const now = new Date();

        const chatById = new Map(existingChats.map((chat) => [chat.id.valueOf(), chat] as const));
        const userById = new Map(existingUsers.map((user) => [user.id.valueOf(), user] as const));
        const memberById = new Map(
          existingMembers.map((member) => [member.id.valueOf(), member] as const),
        );

        const chatSummaries = new Map<string, TelegramChatSummary>();
        for (const chat of chatsForUpsert) {
          const id = String(chat.id);
          const existing = chatById.get(id);
          if (!existing) {
            uow.create("chat", {
              id,
              type: chat.type,
              title: chat.title ?? null,
              username: chat.username ?? null,
              isForum: chat.is_forum ?? false,
              commandBindings: null,
              createdAt: now,
              updatedAt: now,
            });

            chatSummaries.set(id, {
              id,
              type: chat.type,
              title: chat.title ?? null,
              username: chat.username ?? null,
              isForum: chat.is_forum ?? false,
              commandBindings: null,
              createdAt: now,
              updatedAt: now,
            });
          } else {
            uow.update("chat", existing.id, (b) =>
              b
                .set({
                  type: chat.type,
                  title: chat.title ?? null,
                  username: chat.username ?? null,
                  isForum: chat.is_forum ?? false,
                  updatedAt: now,
                })
                .check(),
            );

            chatSummaries.set(id, {
              ...toChatSummary(existing),
              type: chat.type,
              title: chat.title ?? null,
              username: chat.username ?? null,
              isForum: chat.is_forum ?? false,
              updatedAt: now,
            });
          }
        }

        const userSummaries = new Map<string, TelegramUserSummary>();
        for (const user of usersForUpsert) {
          const id = String(user.id);
          const existing = userById.get(id);
          if (!existing) {
            uow.create("user", {
              id,
              username: user.username ?? null,
              firstName: user.first_name,
              lastName: user.last_name ?? null,
              isBot: user.is_bot ?? false,
              languageCode: user.language_code ?? null,
              createdAt: now,
              updatedAt: now,
            });

            userSummaries.set(id, {
              id,
              username: user.username ?? null,
              firstName: user.first_name,
              lastName: user.last_name ?? null,
              isBot: user.is_bot ?? false,
              languageCode: user.language_code ?? null,
              createdAt: now,
              updatedAt: now,
            });
          } else {
            uow.update("user", existing.id, (b) =>
              b
                .set({
                  username: user.username ?? null,
                  firstName: user.first_name,
                  lastName: user.last_name ?? null,
                  isBot: user.is_bot ?? false,
                  languageCode: user.language_code ?? null,
                  updatedAt: now,
                })
                .check(),
            );

            userSummaries.set(id, {
              ...toUserSummary(existing),
              username: user.username ?? null,
              firstName: user.first_name,
              lastName: user.last_name ?? null,
              isBot: user.is_bot ?? false,
              languageCode: user.language_code ?? null,
              updatedAt: now,
            });
          }
        }

        const memberPayloads: TelegramChatMemberHookPayload[] = [];
        for (const [userId, membership] of membershipMap.entries()) {
          const memberId = buildChatMemberId(chatId, userId);
          const existing = memberById.get(memberId);

          if (!existing) {
            uow.create("chatMember", {
              id: memberId,
              chatId,
              userId,
              status: membership.status,
              joinedAt: membership.joinedAt,
              leftAt: membership.leftAt,
              createdAt: now,
              updatedAt: now,
            });

            if (membership.notify) {
              memberPayloads.push({
                updateId,
                chatId,
                userId,
                status: membership.status,
                joinedAt: membership.joinedAt,
                leftAt: membership.leftAt,
              });
            }
            continue;
          }

          const hasExplicitJoin =
            membership.status === "member" && membership.joinedAt !== null && membership.notify;
          const nextJoinedAt = hasExplicitJoin ? membership.joinedAt : existing.joinedAt;
          const nextLeftAt =
            membership.status === "left"
              ? (membership.leftAt ?? existing.leftAt ?? now)
              : membership.status === "member"
                ? null
                : existing.leftAt;

          const changed =
            existing.status !== membership.status ||
            existing.joinedAt?.getTime() !== nextJoinedAt?.getTime() ||
            existing.leftAt?.getTime() !== nextLeftAt?.getTime();

          if (changed) {
            uow.update("chatMember", existing.id, (b) =>
              b
                .set({
                  status: membership.status,
                  joinedAt: nextJoinedAt,
                  leftAt: nextLeftAt,
                  updatedAt: now,
                })
                .check(),
            );

            if (membership.notify) {
              memberPayloads.push({
                updateId,
                chatId,
                userId,
                status: membership.status,
                joinedAt: nextJoinedAt,
                leftAt: nextLeftAt,
              });
            }
          }
        }

        let shouldTriggerMessage = false;
        let messageSummary: TelegramMessageSummary;
        if (!existingMessage) {
          uow.create("message", {
            id: messageId,
            chatId,
            fromUserId,
            senderChatId,
            replyToMessageId,
            messageType: type,
            text: message.text ?? null,
            payload: message,
            sentAt,
            editedAt,
            commandName,
          });

          shouldTriggerMessage = true;
          messageSummary = {
            id: messageId,
            chatId,
            fromUserId,
            senderChatId,
            replyToMessageId,
            messageType: type,
            text: message.text ?? null,
            payload: message,
            sentAt,
            editedAt,
            commandName,
            fromUser: fromUserId ? (userSummaries.get(fromUserId) ?? null) : null,
          };
        } else {
          const isEdit = type === "edited_message";
          const duplicateEdit =
            isEdit &&
            existingMessage.editedAt?.getTime() === editedAt?.getTime() &&
            existingMessage.text === (message.text ?? null);

          if (isEdit && !duplicateEdit) {
            uow.update("message", existingMessage.id, (b) =>
              b
                .set({
                  messageType: type,
                  text: message.text ?? null,
                  payload: message,
                  editedAt,
                  commandName,
                })
                .check(),
            );
            shouldTriggerMessage = true;
          }

          messageSummary = {
            id: String(existingMessage.id.valueOf()),
            chatId: String(existingMessage.chatId.valueOf()),
            fromUserId: existingMessage.fromUserId
              ? String(existingMessage.fromUserId.valueOf())
              : null,
            senderChatId: existingMessage.senderChatId
              ? String(existingMessage.senderChatId.valueOf())
              : null,
            replyToMessageId: existingMessage.replyToMessageId
              ? String(existingMessage.replyToMessageId.valueOf())
              : null,
            messageType: type,
            text: message.text ?? existingMessage.text,
            payload: message,
            sentAt: existingMessage.sentAt,
            editedAt: editedAt ?? existingMessage.editedAt,
            commandName,
            fromUser: fromUserId ? (userSummaries.get(fromUserId) ?? null) : null,
          };
        }

        const chatSummary =
          chatSummaries.get(chatId) ??
          (chatById.get(chatId)
            ? toChatSummary(chatById.get(chatId)!)
            : {
                id: chatId,
                type: message.chat.type,
                title: message.chat.title ?? null,
                username: message.chat.username ?? null,
                isForum: message.chat.is_forum ?? false,
                commandBindings: null,
                createdAt: now,
                updatedAt: now,
              });

        const commandBindings = chatSummary.commandBindings
          ? parseCommandBindings(chatSummary.commandBindings)
          : {};

        let commandResult: {
          name: string;
          args: string;
          raw: string;
          scopes: TelegramCommandScope[];
        } | null = null;

        if (commandMatch && type !== "edited_message") {
          const resolved = resolveCommandScopes(
            commandMatch.name,
            chatSummary.type,
            commandBindings,
          );
          if (resolved) {
            commandResult = {
              name: commandMatch.name,
              args: commandMatch.args,
              raw: commandMatch.raw,
              scopes: resolved.scopes,
            };

            if (shouldTriggerMessage) {
              uow.triggerHook("onCommandMatched", {
                updateId,
                messageId: messageSummary.id,
                chatId,
                fromUserId,
                commandName: commandMatch.name,
                args: commandMatch.args,
                raw: commandMatch.raw,
                sentAt,
              });
            }
          }
        }

        if (shouldTriggerMessage) {
          const payload: TelegramMessageHookPayload = {
            updateId,
            updateType: type,
            messageId: messageSummary.id,
            chatId,
            fromUserId,
            text: message.text ?? null,
            commandName,
            sentAt: messageSummary.sentAt,
            editedAt: messageSummary.editedAt,
          };

          uow.triggerHook("onMessageReceived", payload);
        }

        for (const payload of memberPayloads) {
          uow.triggerHook("onChatMemberUpdated", payload);
        }

        return {
          kind: "message",
          updateId,
          updateType: type,
          chat: chatSummary,
          message: messageSummary,
          fromUser: fromUserId ? (userSummaries.get(fromUserId) ?? null) : null,
          command: commandResult,
        } satisfies ProcessIncomingUpdateResult;
      },
    };
  };
};

export const createTelegramServices = (config: TelegramFragmentConfig) => {
  const buildProcessIncomingUpdateOps = createProcessIncomingUpdateOps(config);
  type ServiceContext = DatabaseServiceContext<TelegramHooksMap>;

  return {
    processIncomingUpdate: function (this: ServiceContext, update: TelegramUpdate) {
      const ops = buildProcessIncomingUpdateOps(update);
      if (ops.kind === "ignored") {
        return this.serviceTx(telegramSchema)
          .mutate(() => ops satisfies ProcessIncomingUpdateResult)
          .build();
      }

      return this.serviceTx(telegramSchema)
        .retrieve(ops.retrieve)
        .mutate(({ uow, retrieveResult }) => ops.mutate({ uow, retrieveResult }))
        .build();
    },

    bindCommand: function (
      this: ServiceContext,
      input: {
        chatId: string;
        commandName: string;
        enabled: boolean;
        scopes?: TelegramCommandScope[];
      },
    ) {
      return this.serviceTx(telegramSchema)
        .retrieve((uow) =>
          uow.findFirst("chat", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", input.chatId)),
          ),
        )
        .mutate(({ uow, retrieveResult: [chat] }) => {
          if (!chat) {
            return { ok: false as const, reason: "chat_not_found" as const };
          }

          const bindings = parseCommandBindings(chat.commandBindings);
          const nextBindings = {
            ...bindings,
            [input.commandName]: {
              enabled: input.enabled,
              scopes: input.scopes,
            },
          };

          uow.update("chat", chat.id, (b) =>
            b
              .set({
                commandBindings: nextBindings,
                updatedAt: new Date(),
              })
              .check(),
          );

          return {
            ok: true as const,
            binding: {
              chatId: input.chatId,
              commandName: input.commandName,
              enabled: input.enabled,
              scopes: input.scopes,
            },
          };
        })
        .build();
    },

    listChats: function (this: ServiceContext, type?: TelegramChatSummary["type"]) {
      return this.serviceTx(telegramSchema)
        .retrieve((uow) => {
          if (type) {
            return uow.find("chat", (b) =>
              b.whereIndex("idx_chat_type", (eb) => eb("type", "=", type)),
            );
          }
          return uow.find("chat", (b) => b.whereIndex("primary"));
        })
        .transformRetrieve(([chats]) => chats.map(toChatSummary))
        .build();
    },

    getChat: function (this: ServiceContext, chatId: string) {
      return this.serviceTx(telegramSchema)
        .retrieve((uow) =>
          uow.findFirst("chat", (b) => b.whereIndex("primary", (eb) => eb("id", "=", chatId))),
        )
        .transformRetrieve(([chat]) => (chat ? toChatSummary(chat) : null))
        .build();
    },

    getChatWithMembers: function (this: ServiceContext, chatId: string) {
      return this.serviceTx(telegramSchema)
        .retrieve((uow) =>
          uow
            .findFirst("chat", (b) => b.whereIndex("primary", (eb) => eb("id", "=", chatId)))
            .find("chatMember", (b) =>
              b
                .whereIndex("idx_chat_member_chat", (eb) => eb("chatId", "=", chatId))
                .join((j) => j.chatMemberUser()),
            ),
        )
        .transformRetrieve(([chat, members]) => ({
          chat: chat ? toChatSummary(chat) : null,
          members: members.map(toChatMemberSummary),
        }))
        .build();
    },

    listMessages: function (
      this: ServiceContext,
      input: {
        chatId: string;
        pageSize: number;
        order: "asc" | "desc";
        cursor?: Cursor;
      },
    ) {
      return this.serviceTx(telegramSchema)
        .retrieve((uow) =>
          uow.findWithCursor("message", (b) => {
            const query = b
              .whereIndex("idx_message_chat_sent", (eb) => eb("chatId", "=", input.chatId))
              .orderByIndex("idx_message_chat_sent", input.order)
              .pageSize(input.pageSize)
              .join((j) => j.messageAuthor());

            return input.cursor ? query.after(input.cursor) : query;
          }),
        )
        .transformRetrieve(([messages]) => ({
          messages: messages.items.map(toMessageSummary),
          cursor: messages.cursor,
          hasNextPage: messages.hasNextPage,
        }))
        .build();
    },
  };
};
