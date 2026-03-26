import type {
  TelegramAttachment,
  TelegramAttachmentPhotoSize,
  TelegramAudio,
  TelegramChat,
  TelegramCommandBindings,
  TelegramCommandScope,
  TelegramDocument,
  TelegramMessage,
  TelegramMessageEntity,
  TelegramPhotoSize,
  TelegramSticker,
  TelegramUpdate,
  TelegramUpdateType,
  TelegramUser,
  TelegramVideo,
  TelegramVideoNote,
  TelegramVoice,
  TelegramAnimation,
} from "./types";
import {
  telegramAudioSchema,
  telegramAnimationSchema,
  telegramChatSchema,
  telegramCommandBindingsSchema,
  telegramDocumentSchema,
  telegramMessageEntitySchema,
  telegramMessageSchema,
  telegramPhotoSizeSchema,
  telegramStickerSchema,
  telegramUpdateSchema,
  telegramUserSchema,
  telegramVideoNoteSchema,
  telegramVideoSchema,
  telegramVoiceSchema,
} from "./types";

export const DEFAULT_COMMAND_SCOPES: TelegramCommandScope[] = [
  "private",
  "group",
  "supergroup",
  "channel",
];

export type ParsedTelegramUpdate = {
  updateId: number;
  type: TelegramUpdateType;
  message: TelegramMessage;
};

type TelegramPhotoSizeInput = Partial<TelegramPhotoSize> & {
  file_id?: string;
  file_unique_id?: string;
  file_size?: number;
};

type TelegramVoiceInput = Partial<TelegramVoice> & {
  file_id?: string;
  file_unique_id?: string;
  mime_type?: string;
  file_size?: number;
};

type TelegramAudioInput = Partial<TelegramAudio> & {
  file_id?: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

type TelegramDocumentInput = Partial<TelegramDocument> & {
  file_id?: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

type TelegramVideoInput = Partial<TelegramVideo> & {
  file_id?: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

type TelegramVideoNoteInput = Partial<TelegramVideoNote> & {
  file_id?: string;
  file_unique_id?: string;
  file_size?: number;
};

type TelegramStickerInput = Partial<TelegramSticker> & {
  file_id?: string;
  file_unique_id?: string;
  is_animated?: boolean;
  is_video?: boolean;
  set_name?: string;
  file_size?: number;
};

type TelegramAnimationInput = Partial<TelegramAnimation> & {
  file_id?: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

type TelegramMessageEntityInput = Partial<TelegramMessageEntity>;

type TelegramUserInput = Partial<TelegramUser> & {
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  language_code?: string;
};

type TelegramChatInput = Partial<TelegramChat> & {
  first_name?: string;
  last_name?: string;
  is_forum?: boolean;
};

type TelegramMessageInput = Partial<TelegramMessage> & {
  message_id?: number;
  edit_date?: number;
  sender_chat?: unknown;
  reply_to_message?: unknown;
  new_chat_members?: unknown[];
  left_chat_member?: unknown;
  media_group_id?: string;
  video_note?: unknown;
};

type TelegramUpdateInput = Partial<TelegramUpdate> & {
  update_id?: number;
  edited_message?: unknown;
  channel_post?: unknown;
};

export function normalizeTelegramPhotoSize(input: unknown): TelegramPhotoSize {
  const photo = input as TelegramPhotoSizeInput;
  return telegramPhotoSizeSchema.parse({
    fileId: photo.fileId ?? photo.file_id,
    fileUniqueId: photo.fileUniqueId ?? photo.file_unique_id,
    width: photo.width,
    height: photo.height,
    fileSize: photo.fileSize ?? photo.file_size,
  });
}

export function normalizeTelegramVoice(input: unknown): TelegramVoice {
  const voice = input as TelegramVoiceInput;
  return telegramVoiceSchema.parse({
    fileId: voice.fileId ?? voice.file_id,
    fileUniqueId: voice.fileUniqueId ?? voice.file_unique_id,
    duration: voice.duration,
    mimeType: voice.mimeType ?? voice.mime_type,
    fileSize: voice.fileSize ?? voice.file_size,
  });
}

export function normalizeTelegramAudio(input: unknown): TelegramAudio {
  const audio = input as TelegramAudioInput;
  return telegramAudioSchema.parse({
    fileId: audio.fileId ?? audio.file_id,
    fileUniqueId: audio.fileUniqueId ?? audio.file_unique_id,
    duration: audio.duration,
    performer: audio.performer,
    title: audio.title,
    fileName: audio.fileName ?? audio.file_name,
    mimeType: audio.mimeType ?? audio.mime_type,
    fileSize: audio.fileSize ?? audio.file_size,
    thumbnail: audio.thumbnail ? normalizeTelegramPhotoSize(audio.thumbnail) : undefined,
  });
}

export function normalizeTelegramDocument(input: unknown): TelegramDocument {
  const document = input as TelegramDocumentInput;
  return telegramDocumentSchema.parse({
    fileId: document.fileId ?? document.file_id,
    fileUniqueId: document.fileUniqueId ?? document.file_unique_id,
    fileName: document.fileName ?? document.file_name,
    mimeType: document.mimeType ?? document.mime_type,
    fileSize: document.fileSize ?? document.file_size,
    thumbnail: document.thumbnail ? normalizeTelegramPhotoSize(document.thumbnail) : undefined,
  });
}

export function normalizeTelegramVideo(input: unknown): TelegramVideo {
  const video = input as TelegramVideoInput;
  return telegramVideoSchema.parse({
    fileId: video.fileId ?? video.file_id,
    fileUniqueId: video.fileUniqueId ?? video.file_unique_id,
    width: video.width,
    height: video.height,
    duration: video.duration,
    fileName: video.fileName ?? video.file_name,
    mimeType: video.mimeType ?? video.mime_type,
    fileSize: video.fileSize ?? video.file_size,
    thumbnail: video.thumbnail ? normalizeTelegramPhotoSize(video.thumbnail) : undefined,
  });
}

export function normalizeTelegramVideoNote(input: unknown): TelegramVideoNote {
  const videoNote = input as TelegramVideoNoteInput;
  return telegramVideoNoteSchema.parse({
    fileId: videoNote.fileId ?? videoNote.file_id,
    fileUniqueId: videoNote.fileUniqueId ?? videoNote.file_unique_id,
    length: videoNote.length,
    duration: videoNote.duration,
    fileSize: videoNote.fileSize ?? videoNote.file_size,
    thumbnail: videoNote.thumbnail ? normalizeTelegramPhotoSize(videoNote.thumbnail) : undefined,
  });
}

export function normalizeTelegramSticker(input: unknown): TelegramSticker {
  const sticker = input as TelegramStickerInput;
  return telegramStickerSchema.parse({
    fileId: sticker.fileId ?? sticker.file_id,
    fileUniqueId: sticker.fileUniqueId ?? sticker.file_unique_id,
    type: sticker.type,
    width: sticker.width,
    height: sticker.height,
    isAnimated: sticker.isAnimated ?? sticker.is_animated,
    isVideo: sticker.isVideo ?? sticker.is_video,
    thumbnail: sticker.thumbnail ? normalizeTelegramPhotoSize(sticker.thumbnail) : undefined,
    emoji: sticker.emoji,
    setName: sticker.setName ?? sticker.set_name,
    fileSize: sticker.fileSize ?? sticker.file_size,
  });
}

export function normalizeTelegramAnimation(input: unknown): TelegramAnimation {
  const animation = input as TelegramAnimationInput;
  return telegramAnimationSchema.parse({
    fileId: animation.fileId ?? animation.file_id,
    fileUniqueId: animation.fileUniqueId ?? animation.file_unique_id,
    width: animation.width,
    height: animation.height,
    duration: animation.duration,
    fileName: animation.fileName ?? animation.file_name,
    mimeType: animation.mimeType ?? animation.mime_type,
    fileSize: animation.fileSize ?? animation.file_size,
    thumbnail: animation.thumbnail ? normalizeTelegramPhotoSize(animation.thumbnail) : undefined,
  });
}

export function normalizeTelegramMessageEntity(input: unknown): TelegramMessageEntity {
  const entity = input as TelegramMessageEntityInput;
  return telegramMessageEntitySchema.parse({
    type: entity.type,
    offset: entity.offset,
    length: entity.length,
  });
}

export function normalizeTelegramUser(input: unknown): TelegramUser {
  const user = input as TelegramUserInput;
  return telegramUserSchema.parse({
    id: user.id,
    isBot: user.isBot ?? user.is_bot,
    firstName: user.firstName ?? user.first_name,
    lastName: user.lastName ?? user.last_name,
    username: user.username,
    languageCode: user.languageCode ?? user.language_code,
  });
}

export function normalizeTelegramChat(input: unknown): TelegramChat {
  const chat = input as TelegramChatInput;
  return telegramChatSchema.parse({
    id: chat.id,
    type: chat.type,
    title: chat.title,
    username: chat.username,
    firstName: chat.firstName ?? chat.first_name,
    lastName: chat.lastName ?? chat.last_name,
    isForum: chat.isForum ?? chat.is_forum,
  });
}

export function normalizeTelegramMessage(input: unknown): TelegramMessage {
  const message = input as TelegramMessageInput;
  return telegramMessageSchema.parse({
    messageId: message.messageId ?? message.message_id,
    date: message.date,
    editDate: message.editDate ?? message.edit_date,
    text: message.text,
    from: message.from ? normalizeTelegramUser(message.from) : undefined,
    senderChat:
      (message.senderChat ?? message.sender_chat)
        ? normalizeTelegramChat(message.senderChat ?? message.sender_chat)
        : undefined,
    chat: normalizeTelegramChat(message.chat),
    replyToMessage:
      (message.replyToMessage ?? message.reply_to_message)
        ? normalizeTelegramMessage(message.replyToMessage ?? message.reply_to_message)
        : undefined,
    newChatMembers: (message.newChatMembers ?? message.new_chat_members)?.map(
      normalizeTelegramUser,
    ),
    leftChatMember:
      (message.leftChatMember ?? message.left_chat_member)
        ? normalizeTelegramUser(message.leftChatMember ?? message.left_chat_member)
        : undefined,
    entities: message.entities?.map(normalizeTelegramMessageEntity),
    mediaGroupId: message.mediaGroupId ?? message.media_group_id,
    photo: message.photo?.map(normalizeTelegramPhotoSize),
    voice: message.voice ? normalizeTelegramVoice(message.voice) : undefined,
    audio: message.audio ? normalizeTelegramAudio(message.audio) : undefined,
    document: message.document ? normalizeTelegramDocument(message.document) : undefined,
    video: message.video ? normalizeTelegramVideo(message.video) : undefined,
    videoNote:
      (message.videoNote ?? message.video_note)
        ? normalizeTelegramVideoNote(message.videoNote ?? message.video_note)
        : undefined,
    sticker: message.sticker ? normalizeTelegramSticker(message.sticker) : undefined,
    animation: message.animation ? normalizeTelegramAnimation(message.animation) : undefined,
  });
}

export function normalizeTelegramUpdate(input: unknown): TelegramUpdate {
  const update = input as TelegramUpdateInput;
  return telegramUpdateSchema.parse({
    updateId: update.updateId ?? update.update_id,
    message: update.message ? normalizeTelegramMessage(update.message) : undefined,
    editedMessage:
      (update.editedMessage ?? update.edited_message)
        ? normalizeTelegramMessage(update.editedMessage ?? update.edited_message)
        : undefined,
    channelPost:
      (update.channelPost ?? update.channel_post)
        ? normalizeTelegramMessage(update.channelPost ?? update.channel_post)
        : undefined,
  });
}

export function safeNormalizeTelegramMessage(input: unknown): TelegramMessage | null {
  try {
    return normalizeTelegramMessage(input);
  } catch {
    return null;
  }
}

export function safeNormalizeTelegramUpdate(input: unknown): TelegramUpdate | null {
  try {
    return normalizeTelegramUpdate(input);
  } catch {
    return null;
  }
}

export function parseTelegramUpdate(update: TelegramUpdate): ParsedTelegramUpdate | null {
  if (update.message) {
    return { updateId: update.updateId, type: "message", message: update.message };
  }
  if (update.editedMessage) {
    return { updateId: update.updateId, type: "edited_message", message: update.editedMessage };
  }
  if (update.channelPost) {
    return { updateId: update.updateId, type: "channel_post", message: update.channelPost };
  }
  return null;
}

export function buildMessageId(chatId: string, messageId: number): string {
  return `${chatId}:${messageId}`;
}

export function buildChatMemberId(chatId: string, userId: string): string {
  return `${chatId}:${userId}`;
}

const isDefined = <T>(value: T | null | undefined): value is T => value != null;

const toAttachmentPhotoSize = (
  photo: TelegramPhotoSize | undefined,
): TelegramAttachmentPhotoSize | null => {
  if (!photo) {
    return null;
  }

  return {
    fileId: photo.fileId,
    fileUniqueId: photo.fileUniqueId,
    fileSize: photo.fileSize,
    width: photo.width,
    height: photo.height,
  };
};

const readThumbnail = (
  value:
    | {
        thumbnail?: TelegramPhotoSize;
      }
    | undefined,
) => toAttachmentPhotoSize(value?.thumbnail) ?? undefined;

export function extractTelegramAttachments(message: TelegramMessage): TelegramAttachment[] {
  const attachments: TelegramAttachment[] = [];

  const photoSizes = message.photo?.map(toAttachmentPhotoSize).filter(isDefined) ?? [];
  const largestPhoto = photoSizes.at(-1);
  if (largestPhoto) {
    attachments.push({
      kind: "photo",
      fileId: largestPhoto.fileId,
      fileUniqueId: largestPhoto.fileUniqueId,
      fileSize: largestPhoto.fileSize,
      width: largestPhoto.width,
      height: largestPhoto.height,
      thumbnail: photoSizes[0],
      sizes: photoSizes,
    });
  }

  if (message.voice) {
    attachments.push({
      kind: "voice",
      fileId: message.voice.fileId,
      fileUniqueId: message.voice.fileUniqueId,
      fileSize: message.voice.fileSize,
      duration: message.voice.duration,
      mimeType: message.voice.mimeType,
    });
  }

  if (message.audio) {
    attachments.push({
      kind: "audio",
      fileId: message.audio.fileId,
      fileUniqueId: message.audio.fileUniqueId,
      fileSize: message.audio.fileSize,
      duration: message.audio.duration,
      performer: message.audio.performer,
      title: message.audio.title,
      fileName: message.audio.fileName,
      mimeType: message.audio.mimeType,
      thumbnail: readThumbnail(message.audio),
    });
  }

  if (message.document) {
    attachments.push({
      kind: "document",
      fileId: message.document.fileId,
      fileUniqueId: message.document.fileUniqueId,
      fileSize: message.document.fileSize,
      fileName: message.document.fileName,
      mimeType: message.document.mimeType,
      thumbnail: readThumbnail(message.document),
    });
  }

  if (message.video) {
    attachments.push({
      kind: "video",
      fileId: message.video.fileId,
      fileUniqueId: message.video.fileUniqueId,
      fileSize: message.video.fileSize,
      width: message.video.width,
      height: message.video.height,
      duration: message.video.duration,
      fileName: message.video.fileName,
      mimeType: message.video.mimeType,
      thumbnail: readThumbnail(message.video),
    });
  }

  if (message.videoNote) {
    attachments.push({
      kind: "video_note",
      fileId: message.videoNote.fileId,
      fileUniqueId: message.videoNote.fileUniqueId,
      fileSize: message.videoNote.fileSize,
      length: message.videoNote.length,
      duration: message.videoNote.duration,
      thumbnail: readThumbnail(message.videoNote),
    });
  }

  if (message.sticker) {
    attachments.push({
      kind: "sticker",
      fileId: message.sticker.fileId,
      fileUniqueId: message.sticker.fileUniqueId,
      fileSize: message.sticker.fileSize,
      width: message.sticker.width,
      height: message.sticker.height,
      emoji: message.sticker.emoji,
      setName: message.sticker.setName,
      isAnimated: message.sticker.isAnimated,
      isVideo: message.sticker.isVideo,
      thumbnail: readThumbnail(message.sticker),
    });
  }

  if (message.animation) {
    attachments.push({
      kind: "animation",
      fileId: message.animation.fileId,
      fileUniqueId: message.animation.fileUniqueId,
      fileSize: message.animation.fileSize,
      width: message.animation.width,
      height: message.animation.height,
      duration: message.animation.duration,
      fileName: message.animation.fileName,
      mimeType: message.animation.mimeType,
      thumbnail: readThumbnail(message.animation),
    });
  }

  return attachments;
}

export function parseCommand(
  message: TelegramMessage,
  botUsername?: string,
): { name: string; args: string; raw: string } | null {
  if (!message.text) {
    return null;
  }

  const text = message.text;
  let commandToken: string | null = null;

  const entity = message.entities?.find(
    (entry) => entry.type === "bot_command" && entry.offset === 0,
  );
  if (entity) {
    commandToken = text.slice(0, entity.length);
  }

  if (!commandToken && text.startsWith("/")) {
    commandToken = text.split(/\s+/)[0] ?? null;
  }

  if (!commandToken) {
    return null;
  }

  const withoutSlash = commandToken.slice(1);
  if (!withoutSlash) {
    return null;
  }

  const [name, atBot] = withoutSlash.split("@");
  if (atBot && botUsername && atBot.toLowerCase() !== botUsername.toLowerCase()) {
    return null;
  }

  const args = text.slice(commandToken.length).trim();

  return {
    name,
    args,
    raw: commandToken,
  };
}

export function parseCommandBindings(value: unknown): TelegramCommandBindings {
  if (!value) {
    return {};
  }
  const result = telegramCommandBindingsSchema.safeParse(value);
  if (!result.success) {
    return {};
  }
  return result.data;
}
