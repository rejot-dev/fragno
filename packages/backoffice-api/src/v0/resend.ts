import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { isoDateTimeOutputSchema, nullableIsoDateTimeOutputSchema } from "./shared/datetime";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";

export const MAX_PAGE_SIZE = 100;

const resendThreadSummaryOutputSchema = z.object({
  id: z.string(),
  subject: z.string().nullable(),
  normalizedSubject: z.string(),
  participants: z.array(z.string()),
  messageCount: z.number().int().nonnegative(),
  firstMessageAt: isoDateTimeOutputSchema,
  lastMessageAt: isoDateTimeOutputSchema,
  lastDirection: z.string().nullable(),
  lastMessagePreview: z.string().nullable(),
  createdAt: isoDateTimeOutputSchema,
  updatedAt: isoDateTimeOutputSchema,
});

const resendThreadDetailOutputSchema = resendThreadSummaryOutputSchema.extend({
  replyToAddress: z.string().nullable(),
});

const resendThreadMessageOutputSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  status: z.string(),
  from: z.string().nullable(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  replyTo: z.array(z.string()),
  subject: z.string().nullable(),
  normalizedSubject: z.string(),
  participants: z.array(z.string()),
  messageId: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()),
  providerEmailId: z.string().nullable(),
  attachments: z.array(
    z.object({
      id: z.string(),
      filename: z.string().nullable(),
      size: z.number().int().nonnegative(),
      contentType: z.string(),
      contentDisposition: z.string().nullable(),
      contentId: z.string().nullable(),
    }),
  ),
  html: z.string().nullable(),
  text: z.string().nullable(),
  headers: z.record(z.string(), z.string()).nullable(),
  occurredAt: isoDateTimeOutputSchema,
  scheduledAt: nullableIsoDateTimeOutputSchema,
  sentAt: nullableIsoDateTimeOutputSchema,
  lastEventType: z.string().nullable(),
  lastEventAt: nullableIsoDateTimeOutputSchema,
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: isoDateTimeOutputSchema,
  updatedAt: isoDateTimeOutputSchema,
});

export const resendListThreadsOutputSchema = z.object({
  threads: z.array(resendThreadSummaryOutputSchema),
  cursor: z.string().optional(),
  hasNextPage: z.boolean(),
});

export const resendThreadMutationOutputSchema = z.object({
  thread: resendThreadDetailOutputSchema,
  message: resendThreadMessageOutputSchema,
});

const threadListInputSchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  order: z.enum(["asc", "desc"]).optional(),
});

const threadMessagesInputSchema = threadListInputSchema.extend({
  threadId: z.string().trim().min(1),
});

const threadReplyInputSchema = z.object({
  threadId: z.string().trim().min(1),
  subject: z.string().trim().min(1).optional(),
  body: z.string().trim().min(1),
});

export const threadSnapshotOutputSchema = z.object({
  thread: resendThreadDetailOutputSchema,
  messages: z.array(resendThreadMessageOutputSchema),
  cursor: z.string().optional(),
  hasNextPage: z.boolean(),
  markdown: z.string(),
});

export const resendOperations = {
  "resend.threads.get": {
    description: "Load a Resend thread with a page of messages and a Markdown snapshot.",
    permissions: [BACKOFFICE_PERMISSION.resend.read],
    input: threadMessagesInputSchema,
    output: threadSnapshotOutputSchema,
  },
  "resend.threads.list": {
    description: "List Resend email threads.",
    permissions: [BACKOFFICE_PERMISSION.resend.read],
    input: threadListInputSchema,
    output: resendListThreadsOutputSchema,
  },
  "resend.threads.reply": {
    description: "Send a text reply into an existing Resend thread.",
    permissions: [BACKOFFICE_PERMISSION.resend.send],
    input: threadReplyInputSchema,
    output: resendThreadMutationOutputSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
