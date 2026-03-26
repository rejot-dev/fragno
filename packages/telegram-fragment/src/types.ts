import { z } from "zod";

import type { HookFn, HookHandlerTx } from "@fragno-dev/db";

const telegramIntegerSchema = z.number().int();

export const telegramChatTypeSchema = z.enum(["private", "group", "supergroup", "channel"]);
export type TelegramChatType = z.infer<typeof telegramChatTypeSchema>;
export type TelegramCommandScope = TelegramChatType;

export const telegramPhotoSizeSchema = z.object({
  fileId: z.string(),
  fileUniqueId: z.string(),
  width: telegramIntegerSchema,
  height: telegramIntegerSchema,
  fileSize: telegramIntegerSchema.optional(),
});
export type TelegramPhotoSize = z.infer<typeof telegramPhotoSizeSchema>;

export const telegramVoiceSchema = z.object({
  fileId: z.string(),
  fileUniqueId: z.string(),
  duration: telegramIntegerSchema,
  mimeType: z.string().optional(),
  fileSize: telegramIntegerSchema.optional(),
});
export type TelegramVoice = z.infer<typeof telegramVoiceSchema>;

export const telegramAudioSchema = z.object({
  fileId: z.string(),
  fileUniqueId: z.string(),
  duration: telegramIntegerSchema,
  performer: z.string().optional(),
  title: z.string().optional(),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  fileSize: telegramIntegerSchema.optional(),
  thumbnail: telegramPhotoSizeSchema.optional(),
});
export type TelegramAudio = z.infer<typeof telegramAudioSchema>;

export const telegramDocumentSchema = z.object({
  fileId: z.string(),
  fileUniqueId: z.string(),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  fileSize: telegramIntegerSchema.optional(),
  thumbnail: telegramPhotoSizeSchema.optional(),
});
export type TelegramDocument = z.infer<typeof telegramDocumentSchema>;

export const telegramVideoSchema = z.object({
  fileId: z.string(),
  fileUniqueId: z.string(),
  width: telegramIntegerSchema,
  height: telegramIntegerSchema,
  duration: telegramIntegerSchema,
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  fileSize: telegramIntegerSchema.optional(),
  thumbnail: telegramPhotoSizeSchema.optional(),
});
export type TelegramVideo = z.infer<typeof telegramVideoSchema>;

export const telegramVideoNoteSchema = z.object({
  fileId: z.string(),
  fileUniqueId: z.string(),
  length: telegramIntegerSchema,
  duration: telegramIntegerSchema,
  fileSize: telegramIntegerSchema.optional(),
  thumbnail: telegramPhotoSizeSchema.optional(),
});
export type TelegramVideoNote = z.infer<typeof telegramVideoNoteSchema>;

export const telegramStickerTypeSchema = z.enum(["regular", "mask", "custom_emoji"]);
export type TelegramStickerType = z.infer<typeof telegramStickerTypeSchema>;

export const telegramStickerSchema = z.object({
  fileId: z.string(),
  fileUniqueId: z.string(),
  type: telegramStickerTypeSchema,
  width: telegramIntegerSchema,
  height: telegramIntegerSchema,
  isAnimated: z.boolean(),
  isVideo: z.boolean(),
  thumbnail: telegramPhotoSizeSchema.optional(),
  emoji: z.string().optional(),
  setName: z.string().optional(),
  fileSize: telegramIntegerSchema.optional(),
});
export type TelegramSticker = z.infer<typeof telegramStickerSchema>;

export const telegramAnimationSchema = z.object({
  fileId: z.string(),
  fileUniqueId: z.string(),
  width: telegramIntegerSchema,
  height: telegramIntegerSchema,
  duration: telegramIntegerSchema,
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  fileSize: telegramIntegerSchema.optional(),
  thumbnail: telegramPhotoSizeSchema.optional(),
});
export type TelegramAnimation = z.infer<typeof telegramAnimationSchema>;

export const telegramAttachmentKindSchema = z.enum([
  "photo",
  "voice",
  "audio",
  "document",
  "video",
  "video_note",
  "sticker",
  "animation",
]);
export type TelegramAttachmentKind = z.infer<typeof telegramAttachmentKindSchema>;

export const telegramAttachmentPhotoSizeSchema = z.object({
  fileId: z.string(),
  fileUniqueId: z.string(),
  fileSize: telegramIntegerSchema.optional(),
  width: telegramIntegerSchema,
  height: telegramIntegerSchema,
});
export type TelegramAttachmentPhotoSize = z.infer<typeof telegramAttachmentPhotoSizeSchema>;

const telegramPhotoAttachmentSchema = z.object({
  kind: z.literal("photo"),
  fileId: z.string(),
  fileUniqueId: z.string(),
  fileSize: telegramIntegerSchema.optional(),
  width: telegramIntegerSchema,
  height: telegramIntegerSchema,
  thumbnail: telegramAttachmentPhotoSizeSchema.optional(),
  sizes: z.array(telegramAttachmentPhotoSizeSchema).min(1),
});

const telegramVoiceAttachmentSchema = z.object({
  kind: z.literal("voice"),
  fileId: z.string(),
  fileUniqueId: z.string(),
  fileSize: telegramIntegerSchema.optional(),
  duration: telegramIntegerSchema,
  mimeType: z.string().optional(),
});

const telegramAudioAttachmentSchema = z.object({
  kind: z.literal("audio"),
  fileId: z.string(),
  fileUniqueId: z.string(),
  fileSize: telegramIntegerSchema.optional(),
  duration: telegramIntegerSchema,
  performer: z.string().optional(),
  title: z.string().optional(),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  thumbnail: telegramAttachmentPhotoSizeSchema.optional(),
});

const telegramDocumentAttachmentSchema = z.object({
  kind: z.literal("document"),
  fileId: z.string(),
  fileUniqueId: z.string(),
  fileSize: telegramIntegerSchema.optional(),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  thumbnail: telegramAttachmentPhotoSizeSchema.optional(),
});

const telegramVideoAttachmentSchema = z.object({
  kind: z.literal("video"),
  fileId: z.string(),
  fileUniqueId: z.string(),
  fileSize: telegramIntegerSchema.optional(),
  width: telegramIntegerSchema,
  height: telegramIntegerSchema,
  duration: telegramIntegerSchema,
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  thumbnail: telegramAttachmentPhotoSizeSchema.optional(),
});

const telegramVideoNoteAttachmentSchema = z.object({
  kind: z.literal("video_note"),
  fileId: z.string(),
  fileUniqueId: z.string(),
  fileSize: telegramIntegerSchema.optional(),
  length: telegramIntegerSchema,
  duration: telegramIntegerSchema,
  thumbnail: telegramAttachmentPhotoSizeSchema.optional(),
});

const telegramStickerAttachmentSchema = z.object({
  kind: z.literal("sticker"),
  fileId: z.string(),
  fileUniqueId: z.string(),
  fileSize: telegramIntegerSchema.optional(),
  width: telegramIntegerSchema,
  height: telegramIntegerSchema,
  emoji: z.string().optional(),
  setName: z.string().optional(),
  isAnimated: z.boolean(),
  isVideo: z.boolean(),
  thumbnail: telegramAttachmentPhotoSizeSchema.optional(),
});

const telegramAnimationAttachmentSchema = z.object({
  kind: z.literal("animation"),
  fileId: z.string(),
  fileUniqueId: z.string(),
  fileSize: telegramIntegerSchema.optional(),
  width: telegramIntegerSchema,
  height: telegramIntegerSchema,
  duration: telegramIntegerSchema,
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  thumbnail: telegramAttachmentPhotoSizeSchema.optional(),
});

export const telegramAttachmentSchema = z.discriminatedUnion("kind", [
  telegramPhotoAttachmentSchema,
  telegramVoiceAttachmentSchema,
  telegramAudioAttachmentSchema,
  telegramDocumentAttachmentSchema,
  telegramVideoAttachmentSchema,
  telegramVideoNoteAttachmentSchema,
  telegramStickerAttachmentSchema,
  telegramAnimationAttachmentSchema,
]);
export type TelegramAttachment = z.infer<typeof telegramAttachmentSchema>;

export const telegramMessageEntitySchema = z.object({
  type: z.string(),
  offset: telegramIntegerSchema,
  length: telegramIntegerSchema,
});
export type TelegramMessageEntity = z.infer<typeof telegramMessageEntitySchema>;

export const telegramUserSchema = z.object({
  id: telegramIntegerSchema,
  isBot: z.boolean(),
  firstName: z.string(),
  lastName: z.string().optional(),
  username: z.string().optional(),
  languageCode: z.string().optional(),
});
export type TelegramUser = z.infer<typeof telegramUserSchema>;

export const telegramChatSchema = z.object({
  id: telegramIntegerSchema,
  type: telegramChatTypeSchema,
  title: z.string().optional(),
  username: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  isForum: z.boolean().optional(),
});
export type TelegramChat = z.infer<typeof telegramChatSchema>;

export interface TelegramMessage {
  messageId: number;
  date: number;
  editDate?: number;
  text?: string;
  from?: TelegramUser;
  senderChat?: TelegramChat;
  chat: TelegramChat;
  replyToMessage?: TelegramMessage;
  newChatMembers?: TelegramUser[];
  leftChatMember?: TelegramUser;
  entities?: TelegramMessageEntity[];
  mediaGroupId?: string;
  photo?: TelegramPhotoSize[];
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  document?: TelegramDocument;
  video?: TelegramVideo;
  videoNote?: TelegramVideoNote;
  sticker?: TelegramSticker;
  animation?: TelegramAnimation;
}

export const telegramMessageSchema: z.ZodType<TelegramMessage> = z.lazy(() =>
  z.object({
    messageId: telegramIntegerSchema,
    date: telegramIntegerSchema,
    editDate: telegramIntegerSchema.optional(),
    text: z.string().optional(),
    from: telegramUserSchema.optional(),
    senderChat: telegramChatSchema.optional(),
    chat: telegramChatSchema,
    replyToMessage: telegramMessageSchema.optional(),
    newChatMembers: z.array(telegramUserSchema).optional(),
    leftChatMember: telegramUserSchema.optional(),
    entities: z.array(telegramMessageEntitySchema).optional(),
    mediaGroupId: z.string().optional(),
    photo: z.array(telegramPhotoSizeSchema).optional(),
    voice: telegramVoiceSchema.optional(),
    audio: telegramAudioSchema.optional(),
    document: telegramDocumentSchema.optional(),
    video: telegramVideoSchema.optional(),
    videoNote: telegramVideoNoteSchema.optional(),
    sticker: telegramStickerSchema.optional(),
    animation: telegramAnimationSchema.optional(),
  }),
);

export interface TelegramUpdate {
  updateId: number;
  message?: TelegramMessage;
  editedMessage?: TelegramMessage;
  channelPost?: TelegramMessage;
}

export const telegramUpdateSchema: z.ZodType<TelegramUpdate> = z.object({
  updateId: telegramIntegerSchema,
  message: telegramMessageSchema.optional(),
  editedMessage: telegramMessageSchema.optional(),
  channelPost: telegramMessageSchema.optional(),
});
export type TelegramUpdateType = "message" | "edited_message" | "channel_post";

export const telegramCommandBindingSchema = z.object({
  enabled: z.boolean().optional(),
  scopes: z.array(telegramChatTypeSchema).optional(),
});
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
  attachments: TelegramAttachment[];
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
  attachments: TelegramAttachment[];
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

export type TelegramOutgoingHookAction = "sendMessage" | "editMessageText";

export type TelegramOutgoingHookPayload = {
  action: TelegramOutgoingHookAction;
  payload: Record<string, unknown>;
};

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
  internalOutgoingMessage: HookFn<TelegramOutgoingHookPayload>;
  onMessageReceived: HookFn<TelegramMessageHookPayload>;
  onCommandMatched: HookFn<TelegramCommandHookPayload>;
  onChatMemberUpdated: HookFn<TelegramChatMemberHookPayload>;
};

export type TelegramApiResult<T> =
  | { ok: true; result: T }
  | { ok: false; errorCode?: number; description?: string };

export interface TelegramApi {
  call<T>(method: string, payload: Record<string, unknown>): Promise<TelegramApiResult<T>>;
  sendMessage(payload: Record<string, unknown>): Promise<TelegramApiResult<TelegramMessage>>;
  editMessageText(payload: Record<string, unknown>): Promise<TelegramApiResult<TelegramMessage>>;
  sendChatAction(payload: Record<string, unknown>): Promise<TelegramApiResult<boolean>>;
}

export type TelegramQueuedResult =
  | { ok: true; queued: true }
  | { ok: false; errorCode?: number; description?: string };

export type TelegramCommandApiResult<T> = TelegramApiResult<T> | TelegramQueuedResult;

export interface TelegramCommandApi {
  call<T>(method: string, payload: Record<string, unknown>): Promise<TelegramCommandApiResult<T>>;
  sendMessage(payload: Record<string, unknown>): Promise<TelegramQueuedResult>;
  editMessageText(payload: Record<string, unknown>): Promise<TelegramQueuedResult>;
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
  api: TelegramCommandApi;
  handlerTx: HookHandlerTx;
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
      const baseCommands = baseConfig.commands ?? {};
      const internalCommands = Object.fromEntries(commands);
      const overrideCommands = overrides.commands ?? {};
      const mergedCommands = {
        ...baseCommands,
        ...internalCommands,
        ...overrideCommands,
      };
      const resolved = {
        ...baseConfig,
        ...overrides,
        commands: mergedCommands,
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
