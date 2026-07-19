import { createRouteCaller, type RouteCallerForFragment } from "@fragno-dev/core/api";

import type {
  ResendListThreadMessagesOutput,
  ResendListThreadsOutput,
  ResendThreadDetail,
  ResendThreadMessage,
  ResendThreadMutationOutput,
  ResendThreadSummary,
} from "@fragno-dev/resend-fragment";

import type { ResendObject } from "@/backoffice-runtime/object-registry";
import type { ResendFragment } from "@/fragno/resend";

import {
  NotConfiguredError,
  createOrganisationNotConfiguredMessage,
  isSuccessStatus,
  throwOnRouteRuntimeError,
} from "../runtime-errors";

const MAX_PAGE_SIZE = 100;

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

export type ResendRuntime = {
  listThreads: (args?: ResendThreadListArgs) => Promise<ResendListThreadsOutput>;
  getThread: (args: { threadId: string }) => Promise<ResendThreadDetail>;
  listThreadMessages: (args: ResendThreadMessagesArgs) => Promise<ResendListThreadMessagesOutput>;
  getThreadSnapshot: (args: ResendThreadsGetArgs) => Promise<ResendThreadsGetResult>;
  replyToThread: (args: ResendThreadsReplyArgs) => Promise<ResendThreadMutationOutput>;
};

export type RegisteredResendCommandContext = {
  runtime: ResendRuntime;
};

type CreateRouteBackedResendRuntimeOptions = {
  baseUrl: string;
  headers?: HeadersInit;
  fetch: (request: Request) => Promise<Response>;
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

const createResendRouteCaller = (
  options: CreateRouteBackedResendRuntimeOptions,
): RouteCallerForFragment<ResendFragment> => {
  return createRouteCaller<ResendFragment>({
    baseUrl: options.baseUrl,
    mountRoute: "/api/resend",
    ...(options.headers ? { baseHeaders: options.headers } : {}),
    fetch: options.fetch,
  });
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

// Route outputs are validated by the Resend fragment contract, whose generated caller defaults to `any`.
// oxlint-disable typescript/no-unsafe-return
export const createRouteBackedResendRuntime = (
  options: CreateRouteBackedResendRuntimeOptions,
): ResendRuntime => {
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
      return throwOnRouteRuntimeError(response, {
        runtimeLabel: "Resend fragment",
        label: "resend.threads.list",
        notConfiguredMessage: RESEND_NOT_CONFIGURED,
      });
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
      return throwOnRouteRuntimeError(response, {
        runtimeLabel: "Resend fragment",
        label: "resend.threads.get detail",
        notConfiguredMessage: RESEND_NOT_CONFIGURED,
      });
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
      return throwOnRouteRuntimeError(response, {
        runtimeLabel: "Resend fragment",
        label: "resend.threads.get messages",
        notConfiguredMessage: RESEND_NOT_CONFIGURED,
      });
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
        return throwOnRouteRuntimeError(thread, {
          runtimeLabel: "Resend fragment",
          label: "resend.threads.get detail",
          notConfiguredMessage: RESEND_NOT_CONFIGURED,
        });
      }
      if (messagePage.type !== "json" || !isSuccessStatus(messagePage.status)) {
        return throwOnRouteRuntimeError(messagePage, {
          runtimeLabel: "Resend fragment",
          label: "resend.threads.get messages",
          notConfiguredMessage: RESEND_NOT_CONFIGURED,
        });
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
        return throwOnRouteRuntimeError(thread, {
          runtimeLabel: "Resend fragment",
          label: "resend.threads.reply detail",
          notConfiguredMessage: RESEND_NOT_CONFIGURED,
        });
      }
      if (messagePage.type !== "json" || !isSuccessStatus(messagePage.status)) {
        return throwOnRouteRuntimeError(messagePage, {
          runtimeLabel: "Resend fragment",
          label: "resend.threads.reply messages",
          notConfiguredMessage: RESEND_NOT_CONFIGURED,
        });
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
      return throwOnRouteRuntimeError(response, {
        runtimeLabel: "Resend fragment",
        label: "resend.threads.reply",
        notConfiguredMessage: RESEND_NOT_CONFIGURED,
      });
    },
  };
};

// oxlint-enable typescript/no-unsafe-return

export const createResendRouteRuntime = ({ object }: { object: ResendObject }): ResendRuntime =>
  createRouteBackedResendRuntime({
    baseUrl: "https://resend.do",
    fetch: object.fetch.bind(object),
  });

const RESEND_NOT_CONFIGURED = createOrganisationNotConfiguredMessage("Resend");

export const createUnavailableResendRuntime = (message = RESEND_NOT_CONFIGURED): ResendRuntime => ({
  listThreads: async () => {
    throw new Error(message);
  },
  getThread: async () => {
    throw new Error(message);
  },
  listThreadMessages: async () => {
    throw new Error(message);
  },
  getThreadSnapshot: async () => {
    throw new Error(message);
  },
  replyToThread: async () => {
    throw new Error(message);
  },
});

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

export { NotConfiguredError };
