import type { TelegramAttachment } from "@fragno-dev/telegram-fragment";

const normalizeAttachmentFilename = (filename: string | null | undefined): string | undefined => {
  const trimmed = filename?.trim();
  if (!trimmed) {
    return undefined;
  }

  const leaf = trimmed
    .split(/[\\/]+/)
    .filter(Boolean)
    .at(-1)
    ?.trim();
  return leaf || undefined;
};

export const getTelegramAttachmentDownloadFileId = (attachment: TelegramAttachment): string => {
  if (attachment.kind !== "photo") {
    return attachment.fileId;
  }

  return attachment.sizes.at(-1)?.fileId ?? attachment.fileId;
};

export const getTelegramAttachmentOriginalFilename = (
  attachment: TelegramAttachment,
): string | undefined => {
  switch (attachment.kind) {
    case "audio":
    case "document":
    case "video":
    case "animation":
      return normalizeAttachmentFilename(attachment.fileName);
    case "photo":
    case "sticker":
    case "video_note":
    case "voice":
      return undefined;
  }

  return undefined;
};

type TelegramAttachmentPathInput = {
  fileId: string;
  kind: TelegramAttachment["kind"];
  filename?: string;
  disposition?: "inline" | "attachment";
};

export const buildTelegramAttachmentPathForBase = (
  basePath: string,
  input: TelegramAttachmentPathInput,
): string => {
  const params = new URLSearchParams({
    fileId: input.fileId,
    kind: input.kind,
    ...(input.disposition === "inline" ? { disposition: "inline" } : {}),
  });

  const filename = normalizeAttachmentFilename(input.filename);
  if (filename) {
    params.set("filename", filename);
  }

  return `${basePath.replace(/\/+$/u, "")}/attachment-download?${params.toString()}`;
};

export const buildTelegramAttachmentPath = buildTelegramAttachmentPathForBase;

export const buildTelegramAttachmentDownloadPath = (
  basePath: string,
  attachment: TelegramAttachment,
): string =>
  buildTelegramAttachmentPathForBase(basePath, {
    fileId: getTelegramAttachmentDownloadFileId(attachment),
    kind: attachment.kind,
    filename: getTelegramAttachmentOriginalFilename(attachment),
  });

export const buildTelegramAttachmentInlinePath = (
  basePath: string,
  attachment: TelegramAttachment,
): string =>
  buildTelegramAttachmentPathForBase(basePath, {
    fileId: attachment.fileId,
    kind: attachment.kind,
    filename: getTelegramAttachmentOriginalFilename(attachment),
    disposition: "inline",
  });
