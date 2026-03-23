import { createRouteCaller } from "@fragno-dev/core/api";

import type {
  ResendListThreadMessagesOutput,
  ResendListThreadsOutput,
  ResendThreadDetail,
  ResendThreadMessage,
  ResendThreadMutationOutput,
  ResendThreadSummary,
} from "@fragno-dev/resend-fragment";

import type { ResendFragment } from "@/fragno/resend";

import { createAutomationCommands } from "../automation/commands/bash-adapter";
import {
  assertNoPositionals,
  parseCliTokens,
  readIntegerOption,
  readOutputOptions,
  readStringOption,
} from "../automation/commands/cli";
import type {
  AutomationCommandHelp,
  AutomationCommandHandlersFor,
  AutomationCommandSpec,
  ParsedCommand,
} from "../automation/commands/types";
import type { BashCommandFactoryInput } from "./bash-host";

const RESEND_COMMAND_NAMES = [
  "resend.threads.get",
  "resend.threads.list",
  "resend.threads.reply",
] as const;
const MAX_PAGE_SIZE = 100;

type FragnoResponse<T> =
  | {
      type: "empty";
      status: number;
      headers: Headers;
    }
  | {
      type: "error";
      status: number;
      headers: Headers;
      error: { message: string; code: string };
    }
  | {
      type: "json";
      status: number;
      headers: Headers;
      data: T;
    }
  | {
      type: "jsonStream";
      status: number;
      headers: Headers;
      stream: AsyncGenerator<T extends unknown[] ? T[number] : T>;
    };

type ResendRouteInput = {
  pathParams?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Headers | Record<string, string>;
};

interface ResendRouteCaller {
  (
    method: "GET",
    path: "/threads",
    inputOptions?: ResendRouteInput,
  ): Promise<FragnoResponse<ResendListThreadsOutput>>;
  (
    method: "GET",
    path: "/threads/:threadId",
    inputOptions: ResendRouteInput,
  ): Promise<FragnoResponse<ResendThreadDetail>>;
  (
    method: "GET",
    path: "/threads/:threadId/messages",
    inputOptions: ResendRouteInput,
  ): Promise<FragnoResponse<ResendListThreadMessagesOutput>>;
  (
    method: "POST",
    path: "/threads/:threadId/reply",
    inputOptions: ResendRouteInput & { body: { to: string[]; subject?: string; text: string } },
  ): Promise<FragnoResponse<ResendThreadMutationOutput>>;
}

export type ResendCommandName = (typeof RESEND_COMMAND_NAMES)[number];
export type ResendThreadOrder = "asc" | "desc";

export type ResendThreadListArgs = {
  cursor?: string;
  pageSize?: number;
  order?: ResendThreadOrder;
};

export type ResendThreadMessagesArgs = ResendThreadListArgs & {
  threadId: string;
};

export type ResendThreadsGetArgs = ResendThreadMessagesArgs;

export type ResendThreadsReplyArgs = {
  threadId: string;
  subject?: string;
  body: string;
};

export type ResendThreadsGetResult = {
  thread: ResendThreadDetail;
  messages: ResendThreadMessage[];
  cursor?: string;
  hasNextPage: boolean;
  markdown: string;
};

export type ResendBashRuntime = {
  listThreads: (args?: ResendThreadListArgs) => Promise<ResendListThreadsOutput>;
  getThread: (args: { threadId: string }) => Promise<ResendThreadDetail>;
  listThreadMessages: (args: ResendThreadMessagesArgs) => Promise<ResendListThreadMessagesOutput>;
  getThreadSnapshot: (args: ResendThreadsGetArgs) => Promise<ResendThreadsGetResult>;
  replyToThread: (args: ResendThreadsReplyArgs) => Promise<ResendThreadMutationOutput>;
};

export type RegisteredResendBashCommandContext = {
  runtime: ResendBashRuntime;
};

export type ResendBashRegistryContext = {
  resend?: RegisteredResendBashCommandContext;
};

type CreateRouteBackedResendRuntimeOptions = {
  baseUrl: string;
  headers?: HeadersInit;
  fetch(request: Request): Promise<Response>;
};

type ResendParsedCommandByName = {
  "resend.threads.get": ParsedCommand<"resend.threads.get", ResendThreadsGetArgs>;
  "resend.threads.list": ParsedCommand<"resend.threads.list", ResendThreadListArgs>;
  "resend.threads.reply": ParsedCommand<"resend.threads.reply", ResendThreadsReplyArgs>;
};

type ResendCommandHandlers<TContext = unknown> = AutomationCommandHandlersFor<
  TContext,
  ResendParsedCommandByName
>;

const HELP: {
  threadsGet: AutomationCommandHelp;
  threadsList: AutomationCommandHelp;
  threadsReply: AutomationCommandHelp;
} = {
  threadsGet: {
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
  threadsList: {
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
  threadsReply: {
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

const parseResendThreadsGet = (args: string[]): ResendParsedCommandByName["resend.threads.get"] => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "resend.threads.get");

  return {
    name: "resend.threads.get",
    args: {
      threadId: readStringOption(parsed, "thread-id", true)!,
      order: normalizeOrder(readStringOption(parsed, "order")),
      pageSize: normalizePageSize(readIntegerOption(parsed, "page-size")),
      cursor: readStringOption(parsed, "cursor") ?? undefined,
    },
    output: readOutputOptions(parsed),
    rawArgs: args,
  };
};

const parseResendThreadsList = (
  args: string[],
): ResendParsedCommandByName["resend.threads.list"] => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "resend.threads.list");

  const output = readOutputOptions(parsed);

  return {
    name: "resend.threads.list",
    args: {
      order: normalizeOrder(readStringOption(parsed, "order")),
      pageSize: normalizePageSize(readIntegerOption(parsed, "page-size")),
      cursor: readStringOption(parsed, "cursor") ?? undefined,
    },
    output: output.print || parsed.options.has("format") ? output : { ...output, format: "json" },
    rawArgs: args,
  };
};

const parseResendThreadsReply = (
  args: string[],
): ResendParsedCommandByName["resend.threads.reply"] => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "resend.threads.reply");

  const output = readOutputOptions(parsed);

  return {
    name: "resend.threads.reply",
    args: {
      threadId: readStringOption(parsed, "thread-id", true)!,
      subject: readStringOption(parsed, "subject") ?? undefined,
      body: readStringOption(parsed, "body", true)!,
    },
    output: output.print || parsed.options.has("format") ? output : { ...output, format: "json" },
    rawArgs: args,
  };
};

const RESEND_COMMAND_SPECS = {
  "resend.threads.get": {
    name: "resend.threads.get",
    help: HELP.threadsGet,
    parse: parseResendThreadsGet,
  },
  "resend.threads.list": {
    name: "resend.threads.list",
    help: HELP.threadsList,
    parse: parseResendThreadsList,
  },
  "resend.threads.reply": {
    name: "resend.threads.reply",
    help: HELP.threadsReply,
    parse: parseResendThreadsReply,
  },
} satisfies {
  [TCommandName in ResendCommandName]: AutomationCommandSpec<
    TCommandName,
    ResendParsedCommandByName[TCommandName]["args"]
  > & {
    parse: (args: string[]) => ResendParsedCommandByName[TCommandName];
  };
};

export const RESEND_COMMAND_SPEC_LIST = RESEND_COMMAND_NAMES.map(
  (name) => RESEND_COMMAND_SPECS[name],
) as readonly (typeof RESEND_COMMAND_SPECS)[ResendCommandName][];

const resendCommandHandlers: ResendCommandHandlers<RegisteredResendBashCommandContext> = {
  "resend.threads.get": async (command, context) => {
    const data = await context.runtime.getThreadSnapshot(command.args);

    if (command.output.format === "json" || command.output.print) {
      return { data };
    }

    return {
      data,
      stdout: `${data.markdown}\n`,
    };
  },
  "resend.threads.list": async (command, context) => {
    return {
      data: await context.runtime.listThreads(command.args),
    };
  },
  "resend.threads.reply": async (command, context) => {
    return {
      data: await context.runtime.replyToThread(command.args),
    };
  },
};

export const createResendBashCommands = <TContext>(input: BashCommandFactoryInput<TContext>) => {
  const resendContext = (input.context as ResendBashRegistryContext).resend;
  if (!resendContext) {
    return [];
  }

  return createAutomationCommands(
    RESEND_COMMAND_SPEC_LIST,
    resendCommandHandlers,
    resendContext,
    input.commandCallsResult,
  );
};

const createResendRouteCaller = (
  options: CreateRouteBackedResendRuntimeOptions,
): ResendRouteCaller => {
  return createRouteCaller<ResendFragment>({
    baseUrl: options.baseUrl,
    mountRoute: "/api/resend",
    ...(options.headers ? { baseHeaders: options.headers } : {}),
    fetch: options.fetch,
  }) as unknown as ResendRouteCaller;
};

const isSuccessStatus = (status: number) => status >= 200 && status < 300;

const getJsonErrorField = (value: unknown, field: "message" | "code") => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const resolved = (value as Record<string, unknown>)[field];
  return typeof resolved === "string" && resolved.trim() ? resolved : null;
};

const throwOnRouteError = (
  response:
    | ({ type: string; status: number } & {
        type: "error";
        error: { message: string; code: string };
      })
    | ({ type: string; status: number } & { type: "json"; data: unknown })
    | { type: string; status: number },
  label: string,
): never => {
  const code =
    "error" in response
      ? getJsonErrorField(response.error, "code")
      : "data" in response
        ? getJsonErrorField(response.data, "code")
        : null;
  const message =
    "error" in response
      ? getJsonErrorField(response.error, "message")
      : "data" in response
        ? getJsonErrorField(response.data, "message")
        : null;

  if (response.status === 400 && code === "NOT_CONFIGURED") {
    throw new NotConfiguredError(message ?? "Resend is not configured.");
  }

  if (message) {
    throw new Error(`Resend fragment returned ${response.status}: ${message}`);
  }

  throw new Error(`Resend fragment returned ${response.status} (${label})`);
};

const toQuery = (args: ResendThreadListArgs | undefined): Record<string, string> => {
  const query: Record<string, string> = {};

  if (args?.cursor) {
    query.cursor = args.cursor;
  }
  if (typeof args?.pageSize === "number") {
    query.pageSize = String(normalizePageSize(args.pageSize));
  }
  if (args?.order) {
    query.order = normalizeOrder(args.order) ?? args.order;
  }

  return query;
};

export const createRouteBackedResendRuntime = (
  options: CreateRouteBackedResendRuntimeOptions,
): ResendBashRuntime => {
  const baseUrl = options.baseUrl.trim();
  if (!baseUrl) {
    throw new Error("Resend runtime requires a base URL");
  }

  const callRoute = createResendRouteCaller({
    ...options,
    baseUrl,
  });

  return {
    listThreads: async (args = {}) => {
      const response = await callRoute("GET", "/threads", {
        query: toQuery(args),
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return throwOnRouteError(response, "resend.threads.list");
    },
    getThread: async ({ threadId }) => {
      const normalizedThreadId = threadId.trim();
      if (!normalizedThreadId) {
        throw new Error("Resend thread lookup requires a thread id");
      }

      const response = await callRoute("GET", "/threads/:threadId", {
        pathParams: { threadId: normalizedThreadId },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return throwOnRouteError(response, "resend.threads.get detail");
    },
    listThreadMessages: async ({ threadId, ...args }) => {
      const normalizedThreadId = threadId.trim();
      if (!normalizedThreadId) {
        throw new Error("Resend thread messages lookup requires a thread id");
      }

      const response = await callRoute("GET", "/threads/:threadId/messages", {
        pathParams: { threadId: normalizedThreadId },
        query: toQuery(args),
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return throwOnRouteError(response, "resend.threads.get messages");
    },
    getThreadSnapshot: async ({ threadId, order, pageSize, cursor }) => {
      const normalizedThreadId = threadId.trim();
      if (!normalizedThreadId) {
        throw new Error("resend.threads.get requires a thread id");
      }

      const [thread, messagePage] = await Promise.all([
        callRoute("GET", "/threads/:threadId", {
          pathParams: { threadId: normalizedThreadId },
        }),
        callRoute("GET", "/threads/:threadId/messages", {
          pathParams: { threadId: normalizedThreadId },
          query: toQuery({ order, pageSize, cursor }),
        }),
      ]);

      if (thread.type !== "json" || !isSuccessStatus(thread.status)) {
        return throwOnRouteError(thread, "resend.threads.get detail");
      }
      if (messagePage.type !== "json" || !isSuccessStatus(messagePage.status)) {
        return throwOnRouteError(messagePage, "resend.threads.get messages");
      }

      const messages = messagePage.data.messages ?? [];
      return {
        thread: thread.data,
        messages,
        cursor: messagePage.data.cursor,
        hasNextPage: messagePage.data.hasNextPage ?? false,
        markdown: buildResendThreadMarkdown(thread.data, messages),
      };
    },
    replyToThread: async ({ threadId, subject, body }) => {
      const normalizedThreadId = threadId.trim();
      if (!normalizedThreadId) {
        throw new Error("resend.threads.reply requires a thread id");
      }

      const normalizedBody = body.trim();
      if (!normalizedBody) {
        throw new Error("resend.threads.reply requires non-empty body text");
      }

      const [thread, messagePage] = await Promise.all([
        callRoute("GET", "/threads/:threadId", {
          pathParams: { threadId: normalizedThreadId },
        }),
        callRoute("GET", "/threads/:threadId/messages", {
          pathParams: { threadId: normalizedThreadId },
          query: toQuery({ order: "desc", pageSize: MAX_PAGE_SIZE }),
        }),
      ]);

      if (thread.type !== "json" || !isSuccessStatus(thread.status)) {
        return throwOnRouteError(thread, "resend.threads.reply detail");
      }
      if (messagePage.type !== "json" || !isSuccessStatus(messagePage.status)) {
        return throwOnRouteError(messagePage, "resend.threads.reply messages");
      }

      const recipients = inferReplyRecipients(messagePage.data.messages ?? []);
      if (recipients.length === 0) {
        throw new Error(
          "resend.threads.reply could not infer recipients from the thread. Use the backoffice UI or extend the command to accept explicit recipients.",
        );
      }

      const normalizedSubject = subject?.trim();
      const response = await callRoute("POST", "/threads/:threadId/reply", {
        pathParams: { threadId: normalizedThreadId },
        body: {
          to: recipients,
          ...(normalizedSubject ? { subject: normalizedSubject } : {}),
          text: normalizedBody,
        },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return throwOnRouteError(response, "resend.threads.reply");
    },
  };
};

export const createResendRouteBashRuntime = createRouteBackedResendRuntime;

const inferReplyRecipients = (messages: ResendThreadMessage[]): string[] => {
  const latestInbound = messages.find((message) => message.direction === "inbound") ?? null;
  if (latestInbound) {
    if (latestInbound.replyTo.length > 0) {
      return latestInbound.replyTo;
    }
    if (latestInbound.from) {
      return [latestInbound.from];
    }
  }

  const latestMessage = messages[0] ?? null;
  if (latestMessage?.to.length) {
    return latestMessage.to;
  }

  return [];
};

const UNKNOWN_DATE_LABEL = "—";

const toDate = (value: string | Date | undefined | null): Date | null => {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const formatDate = (value: string | Date | undefined | null): string => {
  const date = toDate(value);
  if (!date) {
    return UNKNOWN_DATE_LABEL;
  }

  return date.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
};

const formatAddressList = (values: string[]) => (values.length > 0 ? values.join(", ") : "—");

const buildCodeFence = (value: string): string => {
  let fence = "```";
  while (value.includes(fence)) {
    fence += "`";
  }

  return fence;
};

export const buildResendThreadMarkdown = (
  thread: ResendThreadSummary | ResendThreadDetail,
  messages: ResendThreadMessage[],
): string => {
  const lines: string[] = [];

  lines.push(`# ${thread.subject ?? "Resend thread"}`);
  lines.push("");
  lines.push(`- Thread ID: ${thread.id}`);
  lines.push(`- Subject: ${thread.subject ?? "—"}`);
  lines.push(`- Participants: ${thread.participants.join(", ") || "—"}`);
  lines.push(`- Message count: ${thread.messageCount}`);
  lines.push(`- First message: ${formatDate(thread.firstMessageAt)}`);
  lines.push(`- Last message: ${formatDate(thread.lastMessageAt)}`);
  lines.push(`- Last direction: ${thread.lastDirection ?? "—"}`);
  if ("replyToAddress" in thread) {
    lines.push(`- Reply-to address: ${thread.replyToAddress ?? "—"}`);
  }
  lines.push("");
  lines.push("## Messages");

  if (messages.length === 0) {
    lines.push("No messages were found in this thread.");
    return lines.join("\n");
  }

  messages.forEach((message, index) => {
    const senderLabel =
      message.direction === "outbound" ? "Outbound (you sent)" : "Inbound (received)";

    lines.push("");
    lines.push(`### Message ${index + 1}: ${senderLabel}`);
    lines.push(`- **Direction:** ${senderLabel}`);
    lines.push(`- **From:** ${message.from ?? "(unknown sender)"}`);
    lines.push(`- **To:** ${formatAddressList(message.to)}`);
    if (message.cc.length > 0) {
      lines.push(`- **CC:** ${formatAddressList(message.cc)}`);
    }
    if (message.bcc.length > 0) {
      lines.push(`- **BCC:** ${formatAddressList(message.bcc)}`);
    }
    if (message.replyTo.length > 0) {
      lines.push(`- **Reply-To:** ${formatAddressList(message.replyTo)}`);
    }
    if (message.subject) {
      lines.push(`- **Subject:** ${message.subject}`);
    }
    lines.push(`- **Sent at:** ${formatDate(message.sentAt)}`);
    lines.push(`- **Occurred at:** ${formatDate(message.occurredAt)}`);
    lines.push(`- **Status:** ${message.status}`);
    lines.push(`- **Provider message ID:** ${message.providerEmailId ?? "—"}`);

    if (message.errorMessage) {
      lines.push(`- **Error:** ${message.errorCode ?? "unknown"}: ${message.errorMessage}`);
    }

    lines.push("");
    const body = message.text ?? message.html ?? "";
    if (body.length > 0) {
      const fence = buildCodeFence(body);
      lines.push(fence);
      lines.push(body.trimEnd());
      lines.push(fence);
    } else {
      lines.push("(No body)");
    }

    if (message.attachments.length > 0) {
      lines.push("");
      lines.push("#### Attachments");
      message.attachments.forEach((attachment) => {
        const name = attachment.filename ?? attachment.id;
        lines.push(`- ${name} (${attachment.size}B, ${attachment.contentType})`);
      });
    }
  });

  return lines.join("\n");
};

export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfiguredError";
  }
}
