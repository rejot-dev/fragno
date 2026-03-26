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
    default:
      return undefined;
  }
};

export const buildTelegramAttachmentPath = (
  orgId: string,
  input: {
    fileId: string;
    kind: TelegramAttachment["kind"];
    filename?: string;
    disposition?: "inline" | "attachment";
  },
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

  return `/backoffice/connections/telegram/${orgId}/attachment-download?${params.toString()}`;
};

export const buildTelegramAttachmentDownloadPath = (
  orgId: string,
  attachment: TelegramAttachment,
): string =>
  buildTelegramAttachmentPath(orgId, {
    fileId: getTelegramAttachmentDownloadFileId(attachment),
    kind: attachment.kind,
    filename: getTelegramAttachmentOriginalFilename(attachment),
  });

export const buildTelegramAttachmentInlinePath = (
  orgId: string,
  attachment: TelegramAttachment,
): string =>
  buildTelegramAttachmentPath(orgId, {
    fileId: attachment.fileId,
    kind: attachment.kind,
    filename: getTelegramAttachmentOriginalFilename(attachment),
    disposition: "inline",
  });
