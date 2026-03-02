import { defineRoutes } from "@fragno-dev/core";
import { z } from "zod";
import { decodeCursor } from "@fragno-dev/db";
import { ExponentialBackoffRetryPolicy } from "@fragno-dev/db";
import { telegramFragmentDefinition } from "./definition";
import { telegramSchema } from "./schema";
import {
  telegramChatTypeSchema,
  telegramCommandBindingsSchema,
  telegramUpdateSchema,
} from "./types";
import type { TelegramCommandScope, TelegramHooksMap } from "./types";
import { DEFAULT_COMMAND_SCOPES, parseCommandBindings } from "./telegram-utils";
import { createTelegramApi } from "./telegram-api";

const chatSummarySchema = z.object({
  id: z.string(),
  type: telegramChatTypeSchema,
  title: z.string().nullable(),
  username: z.string().nullable(),
  isForum: z.boolean(),
  commandBindings: telegramCommandBindingsSchema.nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const userSummarySchema = z.object({
  id: z.string(),
  username: z.string().nullable(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  isBot: z.boolean(),
  languageCode: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const chatMemberSummarySchema = z.object({
  id: z.string(),
  chatId: z.string(),
  userId: z.string(),
  status: z.string(),
  joinedAt: z.date().nullable(),
  leftAt: z.date().nullable(),
  user: userSummarySchema.nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const messageSummarySchema = z.object({
  id: z.string(),
  chatId: z.string(),
  fromUserId: z.string().nullable(),
  senderChatId: z.string().nullable(),
  replyToMessageId: z.string().nullable(),
  messageType: z.enum(["message", "edited_message", "channel_post"]),
  text: z.string().nullable(),
  payload: z.unknown().nullable(),
  sentAt: z.date(),
  editedAt: z.date().nullable(),
  commandName: z.string().nullable(),
  fromUser: userSummarySchema.nullable(),
});

const commandBindingInputSchema = z.object({
  chatId: z.string(),
  commandName: z.string(),
  enabled: z.boolean().optional().default(true),
  scopes: z.array(telegramChatTypeSchema).optional(),
});

const commandBindingOutputSchema = z.object({
  chatId: z.string(),
  commandName: z.string(),
  enabled: z.boolean(),
  scopes: z.array(telegramChatTypeSchema).optional(),
});

const commandOutputSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  scopes: z.array(telegramChatTypeSchema),
  enabled: z.boolean().optional(),
  effectiveScopes: z.array(telegramChatTypeSchema).optional(),
  binding: z
    .object({
      enabled: z.boolean().optional(),
      scopes: z.array(telegramChatTypeSchema).optional(),
    })
    .nullable()
    .optional(),
});

const actionSchema = z.enum([
  "typing",
  "upload_photo",
  "record_video",
  "upload_video",
  "record_voice",
  "upload_voice",
  "upload_document",
  "choose_sticker",
  "find_location",
  "record_video_note",
  "upload_video_note",
]);

const sendMessageSchema = z.object({
  text: z.string().min(1),
  parseMode: z.enum(["MarkdownV2", "Markdown", "HTML"]).optional(),
  disableWebPagePreview: z.boolean().optional(),
  replyToMessageId: z.coerce.number().optional(),
});

const editMessageSchema = z.object({
  text: z.string().min(1),
  parseMode: z.enum(["MarkdownV2", "Markdown", "HTML"]).optional(),
  disableWebPagePreview: z.boolean().optional(),
});

const webhookOutputSchema = z.object({
  ok: z.boolean(),
  duplicate: z.boolean().optional(),
});

const isDuplicateHookError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message) : "";
  if (code === "SQLITE_CONSTRAINT" || code === "23505") {
    return message.includes("fragno_hooks") || message.includes("hook");
  }
  return message.toLowerCase().includes("duplicate") || message.toLowerCase().includes("unique");
};

const filterUndefined = (payload: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));

export const telegramRoutesFactory = defineRoutes(telegramFragmentDefinition).create(
  ({ defineRoute, services, config }) => {
    const api = createTelegramApi(config);

    return [
      defineRoute({
        method: "POST",
        path: "/telegram/webhook",
        inputSchema: telegramUpdateSchema,
        outputSchema: webhookOutputSchema,
        errorCodes: ["UNAUTHORIZED"] as const,
        handler: async function ({ headers, input }, { json, error }) {
          const secret = headers.get("x-telegram-bot-api-secret-token");
          if (!secret || secret !== config.webhookSecretToken) {
            return error({ message: "Unauthorized", code: "UNAUTHORIZED" }, 401);
          }

          const update = await input.valid();

          try {
            await this.handlerTx()
              .mutate(({ forSchema }) => {
                const uow = forSchema(telegramSchema, {} as TelegramHooksMap);
                uow.triggerHook(
                  "internalProcessUpdate",
                  { update },
                  { id: String(update.update_id) },
                );
              })
              .execute();

            return json({ ok: true });
          } catch (err) {
            console.error("telegram webhook hook insert error", err);
            if (isDuplicateHookError(err)) {
              return json({ ok: true, duplicate: true });
            }
            throw err;
          }
        },
      }),

      defineRoute({
        method: "POST",
        path: "/commands/bind",
        inputSchema: commandBindingInputSchema,
        outputSchema: commandBindingOutputSchema,
        errorCodes: ["chat_not_found", "command_not_found", "invalid_scopes"] as const,
        handler: async function ({ input }, { json, error }) {
          const payload = await input.valid();
          const command = (config.commands ?? {})[payload.commandName];

          if (!command) {
            return error({ message: "Command not found", code: "command_not_found" }, 404);
          }

          const allowedScopes = command.scopes ?? DEFAULT_COMMAND_SCOPES;
          if (
            payload.scopes &&
            !payload.scopes.every((scope: TelegramCommandScope) => allowedScopes.includes(scope))
          ) {
            return error({ message: "Invalid scopes", code: "invalid_scopes" }, 400);
          }

          const result = await this.handlerTx({
            retryPolicy: new ExponentialBackoffRetryPolicy({
              maxRetries: 5,
              initialDelayMs: 10,
              maxDelayMs: 250,
            }),
          })
            .withServiceCalls(
              () =>
                [
                  services.bindCommand({
                    chatId: payload.chatId,
                    commandName: payload.commandName,
                    enabled: payload.enabled,
                    scopes: payload.scopes,
                  }),
                ] as const,
            )
            .transform(({ serviceResult: [result] }) => result)
            .execute();

          if (!result.ok) {
            return error({ message: "Chat not found", code: "chat_not_found" }, 404);
          }

          return json(result.binding);
        },
      }),

      defineRoute({
        method: "GET",
        path: "/commands",
        queryParameters: ["chatId"],
        outputSchema: z.object({
          commands: z.array(commandOutputSchema),
        }),
        errorCodes: ["chat_not_found"] as const,
        handler: async function ({ query }, { json, error }) {
          const chatId = query.get("chatId") ?? undefined;
          const commandDefinitions = Object.values(config.commands ?? {});

          if (!chatId) {
            return json({
              commands: commandDefinitions.map((command) => ({
                name: command.name,
                description: command.description,
                scopes: command.scopes ?? DEFAULT_COMMAND_SCOPES,
              })),
            });
          }

          const chat = await this.handlerTx()
            .withServiceCalls(() => [services.getChat(chatId)] as const)
            .transform(({ serviceResult: [result] }) => result)
            .execute();

          if (!chat) {
            return error({ message: "Chat not found", code: "chat_not_found" }, 404);
          }

          const bindings = parseCommandBindings(chat.commandBindings);

          return json({
            commands: commandDefinitions.map((command) => {
              const binding = bindings[command.name] ?? null;
              const enabled = binding ? binding.enabled !== false : true;
              const defaultScopes = command.scopes ?? DEFAULT_COMMAND_SCOPES;
              const effectiveScopes = binding?.scopes ?? defaultScopes;

              return {
                name: command.name,
                description: command.description,
                scopes: defaultScopes,
                enabled,
                effectiveScopes,
                binding,
              };
            }),
          });
        },
      }),

      defineRoute({
        method: "GET",
        path: "/chats",
        queryParameters: ["type"],
        outputSchema: z.array(chatSummarySchema),
        handler: async function ({ query }, { json }) {
          const parsed = z
            .object({ type: telegramChatTypeSchema.optional() })
            .parse({ type: query.get("type") ?? undefined });

          const chats = await this.handlerTx()
            .withServiceCalls(() => [services.listChats(parsed.type)] as const)
            .transform(({ serviceResult: [result] }) => result)
            .execute();

          return json(chats);
        },
      }),

      defineRoute({
        method: "GET",
        path: "/chats/:chatId",
        outputSchema: z.object({
          chat: chatSummarySchema,
          members: z.array(chatMemberSummarySchema),
        }),
        errorCodes: ["chat_not_found"] as const,
        handler: async function ({ pathParams }, { json, error }) {
          const result = await this.handlerTx()
            .withServiceCalls(() => [services.getChatWithMembers(pathParams.chatId)] as const)
            .transform(({ serviceResult: [result] }) => result)
            .execute();

          if (!result.chat) {
            return error({ message: "Chat not found", code: "chat_not_found" }, 404);
          }

          return json({
            chat: result.chat,
            members: result.members,
          });
        },
      }),

      defineRoute({
        method: "GET",
        path: "/chats/:chatId/messages",
        queryParameters: ["cursor", "pageSize", "order"],
        outputSchema: z.object({
          messages: z.array(messageSummarySchema),
          cursor: z.string().optional(),
          hasNextPage: z.boolean(),
        }),
        handler: async function ({ pathParams, query }, { json }) {
          const parsed = z
            .object({
              cursor: z.string().optional(),
              pageSize: z.coerce.number().min(1).max(100).catch(50),
              order: z.enum(["asc", "desc"]).catch("desc"),
            })
            .parse({
              cursor: query.get("cursor") ?? undefined,
              pageSize: query.get("pageSize"),
              order: query.get("order"),
            });

          const cursor = parsed.cursor
            ? (() => {
                try {
                  return decodeCursor(parsed.cursor!);
                } catch {
                  return undefined;
                }
              })()
            : undefined;

          const result = await this.handlerTx()
            .withServiceCalls(
              () =>
                [
                  services.listMessages({
                    chatId: pathParams.chatId,
                    pageSize: parsed.pageSize,
                    order: parsed.order,
                    cursor,
                  }),
                ] as const,
            )
            .transform(({ serviceResult: [result] }) => result)
            .execute();

          return json({
            messages: result.messages,
            cursor: result.cursor?.encode(),
            hasNextPage: result.hasNextPage,
          });
        },
      }),

      defineRoute({
        method: "POST",
        path: "/chats/:chatId/actions",
        inputSchema: z.object({ action: actionSchema }),
        outputSchema: z.object({ ok: z.boolean() }),
        errorCodes: ["TELEGRAM_API_ERROR"] as const,
        handler: async function ({ pathParams, input }, { json, error }) {
          const { action } = await input.valid();
          const result = await api.sendChatAction({
            chat_id: pathParams.chatId,
            action,
          });

          if (!result.ok) {
            return error(
              { message: result.description ?? "Telegram API error", code: "TELEGRAM_API_ERROR" },
              502,
            );
          }

          return json({ ok: true });
        },
      }),

      defineRoute({
        method: "POST",
        path: "/chats/:chatId/send",
        inputSchema: sendMessageSchema,
        outputSchema: messageSummarySchema,
        errorCodes: ["TELEGRAM_API_ERROR"] as const,
        handler: async function ({ pathParams, input }, { json, error }) {
          const payload = await input.valid();

          const result = await api.sendMessage(
            filterUndefined({
              chat_id: pathParams.chatId,
              text: payload.text,
              parse_mode: payload.parseMode,
              disable_web_page_preview: payload.disableWebPagePreview,
              reply_to_message_id: payload.replyToMessageId,
            }),
          );

          if (!result.ok) {
            return error(
              { message: result.description ?? "Telegram API error", code: "TELEGRAM_API_ERROR" },
              502,
            );
          }

          const message = result.result;

          await this.handlerTx()
            .withServiceCalls(
              () =>
                [
                  services.upsertOutgoingMessage({
                    message,
                    messageType: "message",
                  }),
                ] as const,
            )
            .execute();

          return json({
            id: `${message.chat.id}:${message.message_id}`,
            chatId: String(message.chat.id),
            fromUserId: message.from ? String(message.from.id) : null,
            senderChatId: message.sender_chat ? String(message.sender_chat.id) : null,
            replyToMessageId: message.reply_to_message
              ? `${message.chat.id}:${message.reply_to_message.message_id}`
              : null,
            messageType: "message",
            text: message.text ?? null,
            payload: message,
            sentAt: new Date(message.date * 1000),
            editedAt: message.edit_date ? new Date(message.edit_date * 1000) : null,
            commandName: null,
            fromUser: message.from
              ? {
                  id: String(message.from.id),
                  username: message.from.username ?? null,
                  firstName: message.from.first_name,
                  lastName: message.from.last_name ?? null,
                  isBot: message.from.is_bot ?? false,
                  languageCode: message.from.language_code ?? null,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                }
              : null,
          });
        },
      }),

      defineRoute({
        method: "POST",
        path: "/chats/:chatId/messages/:messageId/edit",
        inputSchema: editMessageSchema,
        outputSchema: messageSummarySchema,
        errorCodes: ["TELEGRAM_API_ERROR", "INVALID_MESSAGE_ID"] as const,
        handler: async function ({ pathParams, input }, { json, error }) {
          const payload = await input.valid();
          const messageId = Number(pathParams.messageId);
          if (!Number.isFinite(messageId)) {
            return error({ message: "Invalid message id", code: "INVALID_MESSAGE_ID" }, 400);
          }

          const result = await api.editMessageText(
            filterUndefined({
              chat_id: pathParams.chatId,
              message_id: messageId,
              text: payload.text,
              parse_mode: payload.parseMode,
              disable_web_page_preview: payload.disableWebPagePreview,
            }),
          );

          if (!result.ok) {
            return error(
              { message: result.description ?? "Telegram API error", code: "TELEGRAM_API_ERROR" },
              502,
            );
          }

          const message = result.result;

          await this.handlerTx()
            .withServiceCalls(
              () =>
                [
                  services.upsertOutgoingMessage({
                    message,
                    messageType: "edited_message",
                  }),
                ] as const,
            )
            .execute();

          return json({
            id: `${message.chat.id}:${message.message_id}`,
            chatId: String(message.chat.id),
            fromUserId: message.from ? String(message.from.id) : null,
            senderChatId: message.sender_chat ? String(message.sender_chat.id) : null,
            replyToMessageId: message.reply_to_message
              ? `${message.chat.id}:${message.reply_to_message.message_id}`
              : null,
            messageType: "edited_message",
            text: message.text ?? null,
            payload: message,
            sentAt: new Date(message.date * 1000),
            editedAt: message.edit_date ? new Date(message.edit_date * 1000) : null,
            commandName: null,
            fromUser: message.from
              ? {
                  id: String(message.from.id),
                  username: message.from.username ?? null,
                  firstName: message.from.first_name,
                  lastName: message.from.last_name ?? null,
                  isBot: message.from.is_bot ?? false,
                  languageCode: message.from.language_code ?? null,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                }
              : null,
          });
        },
      }),
    ];
  },
);
