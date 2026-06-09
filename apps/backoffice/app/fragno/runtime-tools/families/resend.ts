import { z } from "zod";

import {
  defineCliArgsParser,
  parseCliTokens,
  readOutputOptions,
} from "@/fragno/runtime-tools/bash-cli";
import type {
  ResendRuntime,
  ResendThreadListArgs,
  ResendThreadMessagesArgs,
  ResendThreadOrder,
  ResendThreadsGetArgs,
  ResendThreadsReplyArgs,
} from "@/fragno/runtime-tools/families/resend-runtime";

import { isoDateTimeOutputSchema, nullableIsoDateTimeOutputSchema } from "../output-schemas";
import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

const MAX_PAGE_SIZE = 100;

type ResendToolContext = BackofficeToolContext<{ resend?: ResendRuntime }>;

const nonEmptyString = z.string().trim().min(1);
const orderSchema = z.enum(["asc", "desc"]).optional();
const pageSizeSchema = z.number().int().min(1).max(MAX_PAGE_SIZE).optional();

const threadListInputSchema = z.object({
  cursor: nonEmptyString.optional(),
  pageSize: pageSizeSchema,
  order: orderSchema,
});

const threadMessagesInputSchema = threadListInputSchema.extend({
  threadId: nonEmptyString,
});

const threadReplyInputSchema = z.object({
  threadId: nonEmptyString,
  subject: nonEmptyString.optional(),
  body: nonEmptyString,
});

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

const resendListThreadsOutputSchema = z.object({
  threads: z.array(resendThreadSummaryOutputSchema),
  cursor: z.string().optional(),
  hasNextPage: z.boolean(),
});

const resendThreadMutationOutputSchema = z.object({
  thread: resendThreadDetailOutputSchema,
  message: resendThreadMessageOutputSchema,
});

const threadSnapshotOutputSchema = z.object({
  thread: resendThreadDetailOutputSchema,
  messages: z.array(resendThreadMessageOutputSchema),
  cursor: z.string().optional(),
  hasNextPage: z.boolean(),
  markdown: z.string(),
});

const getResendRuntime = (runtime: ResendToolContext["runtimes"]["resend"]): ResendRuntime => {
  if (!runtime) {
    throw new Error("Resend runtime is not available in this execution context");
  }
  return runtime;
};

const normalizeOrder = (value: string | undefined): ResendThreadOrder | undefined => {
  if (typeof value === "undefined") {
    return undefined;
  }
  if (value !== "asc" && value !== "desc") {
    throw new Error("--order must be one of: asc, desc");
  }
  return value;
};

const normalizePageSize = (value: number | undefined, optionName = "page-size") => {
  if (typeof value === "undefined") {
    return undefined;
  }
  if (value < 1 || value > MAX_PAGE_SIZE) {
    throw new Error(`--${optionName} must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  return value;
};

const threadListArgFields = {
  order: { transform: (value) => normalizeOrder(value) },
  pageSize: { kind: "integer", transform: (value) => normalizePageSize(value) },
  cursor: {},
} satisfies Parameters<typeof defineCliArgsParser<ResendThreadListArgs>>[1];

const parseThreadsList = defineCliArgsParser<ResendThreadListArgs>(
  "resend.threads.list",
  threadListArgFields,
);

const parseThreadsGet = defineCliArgsParser<ResendThreadsGetArgs>("resend.threads.get", {
  threadId: { required: true },
  ...threadListArgFields,
});

const parseThreadsReply = defineCliArgsParser<ResendThreadsReplyArgs>("resend.threads.reply", {
  threadId: { required: true },
  subject: {},
  body: { required: true },
});

const jsonByDefaultOutputOptions = (args: string[]) => {
  const parsed = parseCliTokens(args);
  const output = readOutputOptions(parsed);
  return output.print || parsed.options.has("format")
    ? output
    : { ...output, format: "json" as const };
};

const threadsGetTool = defineBackofficeRuntimeTool({
  id: "resend.threads.get",
  namespace: "resend",
  name: "getThread",
  description: "Load a Resend thread with a page of messages and a Markdown snapshot.",
  inputSchema: threadMessagesInputSchema,
  outputSchema: threadSnapshotOutputSchema,
  execute: async (input, context: ResendToolContext) => {
    return threadSnapshotOutputSchema.parse(
      await getResendRuntime(context.runtimes.resend).getThreadSnapshot(input),
    );
  },
  adapters: {
    bash: {
      command: "resend.threads.get",
      help: {
        summary:
          "resend.threads.get loads one Resend thread with its current page of messages and renders a Markdown snapshot by default.",
        options: [
          {
            name: "thread-id",
            required: true,
            valueRequired: true,
            valueName: "thread-id",
            description: "Resend thread id to retrieve",
          },
          {
            name: "order",
            valueRequired: true,
            valueName: "order",
            description: "Message sort order (asc|desc)",
          },
          {
            name: "page-size",
            valueRequired: true,
            valueName: "page-size",
            description: `Maximum number of messages to return (1-${MAX_PAGE_SIZE})`,
          },
          {
            name: "cursor",
            valueRequired: true,
            valueName: "cursor",
            description: "Opaque message pagination cursor",
          },
        ],
        examples: [
          "resend.threads.get --thread-id thread-123",
          "resend.threads.get --thread-id thread-123 --format json",
          "resend.threads.get --thread-id thread-123 --print thread.reply-to-address",
        ],
      },
      parse: parseThreadsGet,
      format: (data, output) => {
        if (output.format === "json" || output.print) {
          return { data };
        }
        return { data, stdout: `${(data as { markdown?: string }).markdown ?? ""}\n` };
      },
    },
  },
});

const threadsListTool = defineBackofficeRuntimeTool({
  id: "resend.threads.list",
  namespace: "resend",
  name: "listThreads",
  description: "List Resend email threads.",
  inputSchema: threadListInputSchema,
  outputSchema: resendListThreadsOutputSchema,
  execute: async (input, context: ResendToolContext) => {
    return resendListThreadsOutputSchema.parse(
      await getResendRuntime(context.runtimes.resend).listThreads(input),
    );
  },
  adapters: {
    bash: {
      command: "resend.threads.list",
      help: {
        summary: "resend.threads.list lists Resend email threads.",
        options: [
          {
            name: "order",
            valueRequired: true,
            valueName: "order",
            description: "Thread sort order (asc|desc)",
          },
          {
            name: "page-size",
            valueRequired: true,
            valueName: "page-size",
            description: `Maximum number of threads to return (1-${MAX_PAGE_SIZE})`,
          },
          {
            name: "cursor",
            valueRequired: true,
            valueName: "cursor",
            description: "Opaque pagination cursor",
          },
        ],
        examples: [
          "resend.threads.list",
          "resend.threads.list --page-size 10 --format json",
          "resend.threads.list --print threads.0.id",
        ],
      },
      parse: parseThreadsList,
      outputOptions: jsonByDefaultOutputOptions,
      format: (data) => ({ data }),
    },
  },
});

const threadsReplyTool = defineBackofficeRuntimeTool({
  id: "resend.threads.reply",
  namespace: "resend",
  name: "replyToThread",
  description: "Send a text reply into an existing Resend thread.",
  inputSchema: threadReplyInputSchema,
  outputSchema: resendThreadMutationOutputSchema,
  execute: async (input, context: ResendToolContext) => {
    return resendThreadMutationOutputSchema.parse(
      await getResendRuntime(context.runtimes.resend).replyToThread(input),
    );
  },
  adapters: {
    bash: {
      command: "resend.threads.reply",
      help: {
        summary: "resend.threads.reply sends a text reply into an existing Resend thread.",
        options: [
          {
            name: "thread-id",
            required: true,
            valueRequired: true,
            valueName: "thread-id",
            description: "Resend thread id to reply to",
          },
          {
            name: "subject",
            valueRequired: true,
            valueName: "subject",
            description: "Optional reply subject override",
          },
          {
            name: "body",
            required: true,
            valueRequired: true,
            valueName: "body",
            description: "Reply body as plain text",
          },
        ],
        examples: [
          'resend.threads.reply --thread-id thread-123 --body "Thanks, received."',
          'resend.threads.reply --thread-id thread-123 --subject "Re: Invoice Update" --body "Following up." --format json',
        ],
      },
      parse: parseThreadsReply,
      outputOptions: jsonByDefaultOutputOptions,
      format: (data) => ({ data }),
    },
  },
});

export const resendRuntimeTools = [threadsGetTool, threadsListTool, threadsReplyTool] as const;

export const resendToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "resend",
  tools: resendRuntimeTools,
  isAvailable: (context: ResendToolContext) => !!context.runtimes.resend,
});

export type {
  ResendRuntime,
  ResendThreadListArgs,
  ResendThreadMessagesArgs,
  ResendThreadsGetArgs,
  ResendThreadsReplyArgs,
};
