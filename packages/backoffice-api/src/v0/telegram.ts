import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";

const actionOutputSchema = z.object({ ok: z.boolean() });

const downloadedFileOutputSchema = z.object({
  bytes: z.array(z.number().int().min(0).max(255)),
  contentType: z.string().optional(),
});

const editMessageInputSchema = z.object({
  chatId: z.string().trim().min(1),
  messageId: z.string().trim().min(1),
  text: z.string().trim().min(1),
  parseMode: z.enum(["MarkdownV2", "Markdown", "HTML"]).optional(),
  disableWebPagePreview: z.boolean().optional(),
});

const fileDownloadInputSchema = z.object({ fileId: z.string().trim().min(1) });

const fileGetInputSchema = z.object({ fileId: z.string().trim().min(1) });

const fileMetadataOutputSchema = z.object({
  fileId: z.string().trim().min(1),
  fileUniqueId: z.string().nullable().optional(),
  filePath: z.string().nullable().optional(),
  fileSize: z.number().int().nullable().optional(),
});

const queuedMessageOutputSchema = z.object({ ok: z.boolean(), queued: z.boolean() });

const sendActionInputSchema = z.object({
  chatId: z.string().trim().min(1),
  action: z.literal("typing"),
});

const sendMessageInputSchema = z.object({
  chatId: z.string().trim().min(1),
  text: z.string().trim().min(1),
  parseMode: z.enum(["MarkdownV2", "Markdown", "HTML"]).optional(),
  disableWebPagePreview: z.boolean().optional(),
  replyToMessageId: z.number().int().optional(),
});

export const telegramOperations = {
  "telegram.file.get": {
    description: "Resolve Telegram attachment metadata.",
    permissions: [BACKOFFICE_PERMISSION.telegram.read],
    input: fileGetInputSchema,
    output: fileMetadataOutputSchema,
  },
  "telegram.file.download": {
    description: "Download a Telegram file and return its bytes.",
    permissions: [BACKOFFICE_PERMISSION.telegram.read],
    input: fileDownloadInputSchema,
    output: downloadedFileOutputSchema,
  },
  "telegram.chat.send": {
    description: "Queue a message to be sent to a Telegram chat.",
    permissions: [BACKOFFICE_PERMISSION.telegram.send],
    input: sendMessageInputSchema,
    output: queuedMessageOutputSchema,
  },
  "telegram.chat.actions": {
    description: "Send a Telegram chat action.",
    permissions: [BACKOFFICE_PERMISSION.telegram.send],
    input: sendActionInputSchema,
    output: actionOutputSchema,
  },
  "telegram.message.edit": {
    description: "Queue an edit of an existing Telegram message.",
    permissions: [BACKOFFICE_PERMISSION.telegram.send],
    input: editMessageInputSchema,
    output: queuedMessageOutputSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
