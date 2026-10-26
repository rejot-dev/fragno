import { createRouteCaller } from "@fragno-dev/core/api";

import type {
  ResendThreadDetail,
  ResendThreadMessage,
  ResendThreadSummary,
} from "@fragno-dev/resend-fragment";

import type { FetchCommands } from "@/backoffice-runtime/object-registry";
import type { ResendFragment } from "@/fragno/resend";

import {
  createOrganizationNotConfiguredMessage,
  isSuccessStatus,
  throwOnRouteRuntimeError,
} from "../runtime-errors";

/** Null selects the route default; callers validate bounds at the edge. */
type ResendPage = {
  cursor: string | null;
  pageSize: number | null;
  order: "asc" | "desc" | null;
};

const RESEND_NOT_CONFIGURED = createOrganizationNotConfiguredMessage("Resend");
const REPLY_CONTEXT_PAGE_SIZE = 100;

function toQuery(page: ResendPage): Record<string, string> {
  return {
    ...(page.cursor === null ? {} : { cursor: page.cursor }),
    ...(page.pageSize === null ? {} : { pageSize: String(page.pageSize) }),
    ...(page.order === null ? {} : { order: page.order }),
  };
}

function routeError(label: string) {
  return { runtimeLabel: "Resend fragment", label, notConfiguredMessage: RESEND_NOT_CONFIGURED };
}

/** Calls the Resend object's thread routes; the receiving object enforces integrations.execute. */
export function createResendRuntime({ object }: { object: FetchCommands }) {
  const callRoute = createRouteCaller<ResendFragment>({
    baseUrl: "https://resend.do",
    mountRoute: "/api/resend",
    fetch: object.fetch.bind(object),
  });

  async function readThread(threadId: string, page: ResendPage, label: string) {
    const [thread, messagePage] = await Promise.all([
      callRoute("GET", "/threads/:threadId", { pathParams: { threadId } }),
      callRoute("GET", "/threads/:threadId/messages", {
        pathParams: { threadId },
        query: toQuery(page),
      }),
    ]);
    if (thread.type !== "json" || !isSuccessStatus(thread.status)) {
      return throwOnRouteRuntimeError(thread, routeError(`${label} detail`));
    }
    if (messagePage.type !== "json" || !isSuccessStatus(messagePage.status)) {
      return throwOnRouteRuntimeError(messagePage, routeError(`${label} messages`));
    }
    return { thread: thread.data, messagePage: messagePage.data };
  }

  return {
    async listThreads(page: ResendPage) {
      const response = await callRoute("GET", "/threads", { query: toQuery(page) });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return { ...response.data, cursor: response.data.cursor ?? null };
      }
      return throwOnRouteRuntimeError(response, routeError("Resend thread listing"));
    },
    async getThreadSnapshot({ threadId, ...page }: { threadId: string } & ResendPage) {
      const { thread, messagePage } = await readThread(threadId, page, "Resend thread read");
      const messages = messagePage.messages ?? [];
      return {
        thread,
        messages,
        cursor: messagePage.cursor ?? null,
        hasNextPage: messagePage.hasNextPage ?? false,
        markdown: buildResendThreadMarkdown(thread, messages),
      };
    },
    async replyToThread({
      threadId,
      subject,
      body,
    }: {
      threadId: string;
      subject: string | null;
      body: string;
    }) {
      const { messagePage } = await readThread(
        threadId,
        { cursor: null, pageSize: REPLY_CONTEXT_PAGE_SIZE, order: "desc" },
        "Resend thread reply",
      );
      const recipients = inferReplyRecipients(messagePage.messages ?? []);
      if (recipients.length === 0) {
        throw new Error(
          "The Resend thread has no sender or recipient to reply to. Reply from the Backoffice Resend page instead.",
        );
      }
      const response = await callRoute("POST", "/threads/:threadId/reply", {
        pathParams: { threadId },
        body: { to: recipients, ...(subject === null ? {} : { subject }), text: body },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return throwOnRouteRuntimeError(response, routeError("Resend thread reply"));
    },
  };
}

function inferReplyRecipients(messages: ResendThreadMessage[]): string[] {
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
}

const UNKNOWN_DATE_LABEL = "—";

function toDate(value: string | Date | undefined | null): Date | null {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(value: string | Date | undefined | null): string {
  const date = toDate(value);
  if (!date) {
    return UNKNOWN_DATE_LABEL;
  }

  return date.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatAddressList(values: string[]) {
  return values.length > 0 ? values.join(", ") : "—";
}

function buildCodeFence(value: string): string {
  let fence = "```";
  while (value.includes(fence)) {
    fence += "`";
  }

  return fence;
}

function buildResendThreadMarkdown(
  thread: ResendThreadSummary | ResendThreadDetail,
  messages: ResendThreadMessage[],
): string {
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
}
