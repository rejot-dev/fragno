import { z } from "zod";
import type { HookContext, HookFn } from "@fragno-dev/db";

export const telegramChatTypeSchema = z.enum(["private", "group", "supergroup", "channel"]);
export type TelegramChatType = z.infer<typeof telegramChatTypeSchema>;
export type TelegramCommandScope = TelegramChatType;

export const telegramMessageEntitySchema = z
  .object({
    type: z.string(),
    offset: z.number(),
    length: z.number(),
  })
  .loose();
export type TelegramMessageEntity = z.infer<typeof telegramMessageEntitySchema>;

export const telegramUserSchema = z
  .object({
    id: z.number(),
    is_bot: z.boolean().optional(),
    first_name: z.string(),
    last_name: z.string().optional(),
    username: z.string().optional(),
    language_code: z.string().optional(),
  })
  .loose();
export type TelegramUser = z.infer<typeof telegramUserSchema>;

export const telegramChatSchema = z
  .object({
    id: z.number(),
    type: telegramChatTypeSchema,
    title: z.string().optional(),
    username: z.string().optional(),
    is_forum: z.boolean().optional(),
  })
  .loose();
export type TelegramChat = z.infer<typeof telegramChatSchema>;

export interface TelegramMessage {
  message_id: number;
  date: number;
  edit_date?: number;
  text?: string;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  chat: TelegramChat;
  reply_to_message?: TelegramMessage;
  new_chat_members?: TelegramUser[];
  left_chat_member?: TelegramUser;
  entities?: TelegramMessageEntity[];
  [key: string]: unknown;
}

export const telegramMessageSchema: z.ZodType<TelegramMessage> = z.lazy(() =>
  z
    .object({
      message_id: z.number(),
      date: z.number(),
      edit_date: z.number().optional(),
      text: z.string().optional(),
      from: telegramUserSchema.optional(),
      sender_chat: telegramChatSchema.optional(),
      chat: telegramChatSchema,
      reply_to_message: telegramMessageSchema.optional(),
      new_chat_members: z.array(telegramUserSchema).optional(),
      left_chat_member: telegramUserSchema.optional(),
      entities: z.array(telegramMessageEntitySchema).optional(),
    })
    .loose(),
);

export const telegramUpdateSchema = z
  .object({
    update_id: z.number(),
    message: telegramMessageSchema.optional(),
    edited_message: telegramMessageSchema.optional(),
    channel_post: telegramMessageSchema.optional(),
  })
  .loose();
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

export type TelegramUpdateType = "message" | "edited_message" | "channel_post";

export const telegramCommandBindingSchema = z
  .object({
    enabled: z.boolean().optional(),
    scopes: z.array(telegramChatTypeSchema).optional(),
  })
  .loose();
export type TelegramCommandBinding = z.infer<typeof telegramCommandBindingSchema>;

export const telegramCommandBindingsSchema = z.record(z.string(), telegramCommandBindingSchema);
export type TelegramCommandBindings = z.infer<typeof telegramCommandBindingsSchema>;

export interface TelegramUserSummary {
  id: string;
  username: string | null;
  firstName: string;
  lastName: string | null;
  isBot: boolean;
  languageCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TelegramChatSummary {
  id: string;
  type: TelegramChatType;
  title: string | null;
  username: string | null;
  isForum: boolean;
  commandBindings: TelegramCommandBindings | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TelegramChatMemberSummary {
  id: string;
  chatId: string;
  userId: string;
  status: string;
  joinedAt: Date | null;
  leftAt: Date | null;
  user: TelegramUserSummary | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TelegramMessageSummary {
  id: string;
  chatId: string;
  fromUserId: string | null;
  senderChatId: string | null;
  replyToMessageId: string | null;
  messageType: TelegramUpdateType;
  text: string | null;
  payload: unknown | null;
  sentAt: Date;
  editedAt: Date | null;
  commandName: string | null;
  fromUser: TelegramUserSummary | null;
}

export interface TelegramMessageHookPayload {
  updateId: number;
  updateType: TelegramUpdateType;
  messageId: string;
  chatId: string;
  fromUserId: string | null;
  text: string | null;
  commandName: string | null;
  sentAt: Date;
  editedAt: Date | null;
}

export interface TelegramCommandHookPayload {
  updateId: number;
  messageId: string;
  chatId: string;
  fromUserId: string | null;
  commandName: string;
  args: string;
  raw: string;
  sentAt: Date;
}

export interface TelegramChatMemberHookPayload {
  updateId: number;
  chatId: string;
  userId: string;
  status: string;
  joinedAt: Date | null;
  leftAt: Date | null;
}

export type TelegramHooks = {
  onMessageReceived?: (payload: TelegramMessageHookPayload) => Promise<void> | void;
  onCommandMatched?: (payload: TelegramCommandHookPayload) => Promise<void> | void;
  onChatMemberUpdated?: (payload: TelegramChatMemberHookPayload) => Promise<void> | void;
};

export type TelegramInternalHookPayload = {
  update: TelegramUpdate;
};

export type TelegramHooksMap = {
  internalProcessUpdate: HookFn<TelegramInternalHookPayload>;
  onMessageReceived: HookFn<TelegramMessageHookPayload>;
  onCommandMatched: HookFn<TelegramCommandHookPayload>;
  onChatMemberUpdated: HookFn<TelegramChatMemberHookPayload>;
};

export type TelegramApiResult<T> =
  | { ok: true; result: T }
  | { ok: false; error_code?: number; description?: string };

export interface TelegramApi {
  call<T>(method: string, payload: Record<string, unknown>): Promise<TelegramApiResult<T>>;
  sendMessage(payload: Record<string, unknown>): Promise<TelegramApiResult<TelegramMessage>>;
  editMessageText(payload: Record<string, unknown>): Promise<TelegramApiResult<TelegramMessage>>;
  sendChatAction(payload: Record<string, unknown>): Promise<TelegramApiResult<boolean>>;
}

export interface TelegramCommandContext {
  updateId: number;
  idempotencyKey: string;
  update: TelegramUpdate;
  message: TelegramMessage;
  chat: TelegramChatSummary;
  fromUser: TelegramUserSummary | null;
  command: {
    name: string;
    args: string;
    raw: string;
  };
  api: TelegramApi;
  handlerTx: HookContext["handlerTx"];
}

export type TelegramCommandHandler = (ctx: TelegramCommandContext) => Promise<void> | void;

export interface TelegramCommandDefinition {
  name: string;
  description?: string;
  scopes?: TelegramCommandScope[];
  handler: TelegramCommandHandler;
}

export type TelegramCommandRegistry = Record<string, TelegramCommandDefinition>;

export interface TelegramFragmentConfig {
  botToken: string;
  webhookSecretToken: string;
  botUsername?: string;
  apiBaseUrl?: string;
  commands?: TelegramCommandRegistry;
  hooks?: TelegramHooks;
}

export type TelegramConfigBuilder = {
  command: (command: TelegramCommandDefinition) => TelegramConfigBuilder;
  build: (overrides?: Partial<TelegramFragmentConfig>) => TelegramFragmentConfig;
};

export function defineCommand(
  name: string,
  definition: Omit<TelegramCommandDefinition, "name">,
): TelegramCommandDefinition {
  return {
    name,
    ...definition,
  };
}

export function createTelegram(
  baseConfig: Partial<TelegramFragmentConfig> = {},
): TelegramConfigBuilder {
  const commands = new Map<string, TelegramCommandDefinition>();

  if (baseConfig.commands) {
    for (const command of Object.values(baseConfig.commands)) {
      commands.set(command.name, command);
    }
  }

  const builder: TelegramConfigBuilder = {
    command(command: TelegramCommandDefinition) {
      commands.set(command.name, command);
      return builder;
    },
    build(overrides: Partial<TelegramFragmentConfig> = {}) {
      const resolved = {
        ...baseConfig,
        ...overrides,
        commands: Object.fromEntries(commands),
      } as TelegramFragmentConfig;

      if (!resolved.botToken) {
        throw new Error("Telegram fragment requires botToken");
      }
      if (!resolved.webhookSecretToken) {
        throw new Error("Telegram fragment requires webhookSecretToken");
      }

      return resolved;
    },
  };

  return builder;
}
