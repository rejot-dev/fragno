import type { PiAgentQueueEntry } from "@fragno-dev/backoffice-api/v0/pi";

import type { AppendMessage, QueueItemState, ThreadMessageLike } from "@assistant-ui/react";
import type { Message as PiDurableMessage } from "@earendil-works/pi-ai";
import type {
  CompactionReason,
  ConversationView,
  EntryRecord,
  InboxState,
  LiveState,
} from "@earendil-works/pi-durable";

import { piCompactionSummary } from "@/fragno/pi/agent/compaction-summary";
import { parsePiAgentPrompt, type PiAgentAttachment } from "@/fragno/pi/agent/pi-agent-attachments";
import type { PiAgentNotification } from "@/fragno/pi/agent/pi-agent-contract";
import {
  parsePiNotificationRequest,
  PI_NOTIFICATION_ENTRY_KIND,
  type PiNotificationReference,
} from "@/fragno/pi/agent/pi-agent-notification-entry";

/** A compaction summary, shown in the transcript where Pi compacted the context. */
export type PiCompactionMessage = {
  role: "compaction";
  reason: CompactionReason;
  summary: string;
  timestamp: number;
};
/** Where the context was cleared; Pi records no time for a reset. */
export type PiResetMessage = {
  role: "reset";
  entryId: number;
};
/** An event a route delivered, shown where Pi placed it in the transcript. */
export type PiNotificationMessage = {
  role: "notification";
  notification: PiAgentNotification;
  timestamp: number;
};
/** The input asking the agent to handle notifications, shown as a divider. */
export type PiNotificationRequestMessage = {
  role: "notification-request";
  notifications: PiNotificationReference[];
  timestamp: number;
};
export type PiConversationMessage =
  | PiDurableMessage
  | PiCompactionMessage
  | PiResetMessage
  | PiNotificationMessage
  | PiNotificationRequestMessage;
export type ToolResultMessage = Extract<PiConversationMessage, { role: "toolResult" }>;
export type PiDraftTool = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  argsText?: string;
  status: "starting" | "running" | "done";
  partialResult?: unknown;
  /** What the running tool last reported for the UI, such as a codemode run's calls so far. */
  partialDetails?: unknown;
  resultMessage?: ToolResultMessage;
};
export type PiDraftAgentActivity =
  | "starting"
  | "thinking"
  | "writing"
  | "tool_calling"
  | "running_tools";

export type PiDraftAgentMessage = {
  activity: PiDraftAgentActivity;
  /** The response being generated; its timestamp is when the response started. */
  assistant?: Extract<PiConversationMessage, { role: "assistant" }>;
  tools: Record<string, PiDraftTool>;
  appendAssistant?: boolean;
};

export type PiContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export type PiToolCallArtifact = {
  completedToolResult: ToolResultMessage | null;
  draftTool: PiDraftTool | null;
};

export type PiCompactionMessageMetadata = {
  kind: "compaction";
  reason: CompactionReason;
};

export type PiResetMessageMetadata = {
  kind: "reset";
};

type PiNotificationMessageMetadata = {
  kind: "notification";
  notification: PiAgentNotification;
};

/** What the reader wrote; the files it carried show beside its text. */
export type PiUserMessageMetadata = {
  kind: "user";
  attachments: PiAgentAttachment[];
};

type PiNotificationRequestMessageMetadata = {
  kind: "notification-request";
  notifications: PiNotificationReference[];
};

/**
 * Events no turn of the agent shows: delivered while it worked on something else, or asked for by
 * a request no turn has answered yet.
 */
export type PiNotificationsMessageMetadata = {
  kind: "notifications";
  notifications: PiAgentNotification[];
  /** The request waiting for its turn; null for events only delivered so far. */
  request: PiNotificationReference[] | null;
};

/** Tokens and cost added up over every model response in a turn. */
export type PiTurnUsage = {
  input: number;
  output: number;
  totalTokens: number;
  /** In US dollars. */
  cost: number;
};

/** One agent turn: every model response between two inputs, joined into one message. */
export type PiAssistantMessageMetadata = {
  kind: "assistant";
  /** From the turn's newest response; earlier errors were retried past. */
  errorMessage: string | null;
  statusText: string | null;
  /** Null while the newest response is still streaming. */
  stopReason: Extract<PiConversationMessage, { role: "assistant" }>["stopReason"] | null;
  /** Null when no response in the turn reported usage. */
  usage: PiTurnUsage | null;
  /** When the newest response ended; null while it streams or when Pi did not time it. */
  finishedAt: Date | null;
  /** The notifications the agent was asked to handle in this turn; null for a turn it chose. */
  notificationRequest: PiNotificationReference[] | null;
  /** The events the turn was given, asked to handle or delivered while it ran; oldest first. */
  notifications: PiAgentNotification[];
};

type AssistantContentBlock = ThreadMessageLike["content"] extends string | readonly (infer Block)[]
  ? Block
  : never;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readableJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};

function normalizePiContentBlock(block: unknown): PiContentBlock | null {
  if (typeof block === "string") {
    return { type: "text", text: block };
  }
  if (!isRecord(block)) {
    return null;
  }

  switch (block.type) {
    case "text":
      if (typeof block.text === "string") {
        return { type: "text", text: block.text };
      }
      break;
    case "thinking":
      if (typeof block.thinking === "string") {
        return { type: "thinking", thinking: block.thinking };
      }
      break;
    case "image":
      if (typeof block.data === "string" && typeof block.mimeType === "string") {
        return { type: "image", data: block.data, mimeType: block.mimeType };
      }
      break;
    case "toolCall":
      if (
        typeof block.id === "string" &&
        typeof block.name === "string" &&
        isRecord(block.arguments)
      ) {
        return {
          type: "toolCall",
          id: block.id,
          name: block.name,
          arguments: block.arguments,
        };
      }
      break;
  }

  return { type: "text", text: readableJson(block) };
}

export function normalizePiContent(content: unknown): PiContentBlock[] {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks.flatMap((block) => {
    const normalizedBlock = normalizePiContentBlock(block);
    return normalizedBlock ? [normalizedBlock] : [];
  });
}

function assistantRecoveryFingerprint(
  message: Extract<PiConversationMessage, { role: "assistant" }>,
) {
  return JSON.stringify(
    normalizePiContent(message.content).filter(
      (block) => block.type !== "thinking" || block.thinking.length > 0,
    ),
  );
}

// Match pi-durable's `CompactionEntry.kind`, `ResetEntry.kind`, and `UserEntry.kind`; their runtime
// exports would pull the harness into the client.
const COMPACTION_ENTRY_KIND = "pi.compaction";
const RESET_ENTRY_KIND = "pi.reset";
const USER_ENTRY_KIND = "pi.user";

function compactionMessage(entry: EntryRecord): PiCompactionMessage {
  // Compaction entries always carry one user message with the wrapped summary and a reason.
  const [message] = entry.model as [Extract<PiDurableMessage, { role: "user" }>];
  const text = normalizePiContent(message.content)
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
  return {
    role: "compaction",
    reason: (entry.data as { reason: CompactionReason }).reason,
    summary: piCompactionSummary(text),
    timestamp: message.timestamp,
  };
}

function notificationMessage(entry: EntryRecord): PiNotificationMessage {
  // Notification entries carry the delivered notification and one user message for the model.
  const [message] = entry.model as [Extract<PiDurableMessage, { role: "user" }>];
  return {
    role: "notification",
    notification: entry.data as PiAgentNotification,
    timestamp: message.timestamp,
  };
}

function userText(content: unknown) {
  return normalizePiContent(content)
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}

function notificationRequestMessage(entry: EntryRecord): PiNotificationRequestMessage | null {
  const [message] = entry.model ?? [];
  if (entry.kind !== USER_ENTRY_KIND || message?.role !== "user") {
    return null;
  }
  const notifications = parsePiNotificationRequest(userText(message.content));
  return (
    notifications && { role: "notification-request", notifications, timestamp: message.timestamp }
  );
}

/**
 * Hides superseded recovery partials while preserving distinct attempts and completed tool rounds.
 * `activeContextStartIndex` is the first message from entry `activeFrom` on, where the active
 * context starts; it is null unless history before that entry is in the view.
 */
export function piConversationMessages(
  entries: ConversationView["entries"],
  activeFrom: number | null,
): { messages: PiConversationMessage[]; activeContextStartIndex: number | null } {
  const completedAssistantAttempts = new Set<string>();
  for (const entry of entries) {
    const taskKey = entry.byTaskId === undefined ? `entry:${entry.id}` : `task:${entry.byTaskId}`;
    for (const message of entry.model ?? []) {
      if (message.role === "assistant" && message.stopReason !== "aborted") {
        completedAssistantAttempts.add(`${taskKey}:${assistantRecoveryFingerprint(message)}`);
      }
    }
  }

  const visibleAbortedAttempts = new Set<string>();
  const messages: PiConversationMessage[] = [];
  let activeContextStartIndex: number | null = null;
  entries.forEach((entry, index) => {
    const previous = entries[index - 1];
    if (activeFrom !== null && previous && previous.id < activeFrom && entry.id >= activeFrom) {
      activeContextStartIndex = messages.length;
    }
    if (entry.kind === COMPACTION_ENTRY_KIND) {
      messages.push(compactionMessage(entry));
      return;
    }
    if (entry.kind === PI_NOTIFICATION_ENTRY_KIND) {
      messages.push(notificationMessage(entry));
      return;
    }
    if (entry.kind === RESET_ENTRY_KIND) {
      // A handoff reset carries the note the new context starts from.
      messages.push({ role: "reset", entryId: entry.id }, ...(entry.model ?? []));
      return;
    }
    const request = notificationRequestMessage(entry);
    if (request) {
      messages.push(request);
      return;
    }
    const taskKey = entry.byTaskId === undefined ? `entry:${entry.id}` : `task:${entry.byTaskId}`;
    const visible = (entry.model ?? []).filter((message) => {
      if (message.role !== "assistant" || message.stopReason !== "aborted") {
        return true;
      }
      const attemptKey = `${taskKey}:${assistantRecoveryFingerprint(message)}`;
      if (completedAssistantAttempts.has(attemptKey) || visibleAbortedAttempts.has(attemptKey)) {
        return false;
      }
      visibleAbortedAttempts.add(attemptKey);
      return true;
    });
    messages.push(...visible);
  });
  return { messages, activeContextStartIndex };
}

/** Whether the conversation works on something: a generation, tools, or input it has yet to place. */
export function isPiConversationRunning(view: ConversationView) {
  const live = view.docs["pi.live"];
  if (live && Object.keys(live).length > 0) {
    return true;
  }
  const inbox = view.docs["pi.inbox"] as { items?: readonly unknown[] } | undefined;
  return (inbox?.items?.length ?? 0) > 0;
}

/** Projects Pi's committed live document into the existing Assistant UI draft model. */
export function piConversationDraftAgentMessage(
  view: ConversationView,
): PiDraftAgentMessage | null {
  const live = view.docs["pi.live"] as Readonly<LiveState> | undefined;
  const assistant = live?.generation?.message as
    | Extract<PiConversationMessage, { role: "assistant" }>
    | undefined;
  // Only the running tools' calls are needed, and the newest one with an ID wins: the partial's,
  // then the newest entries'. They belong to the running turn, so the scan stops long before the
  // conversation's start, which keeps each partial's cost independent of the conversation's length.
  const wantedCallIds = new Set((live?.tools ?? []).map((slot) => slot.callId));
  const toolCallsById = new Map<string, Extract<PiContentBlock, { type: "toolCall" }>>();
  function collectToolCalls(content: unknown) {
    for (const block of normalizePiContent(content)) {
      if (
        block.type === "toolCall" &&
        wantedCallIds.has(block.id) &&
        !toolCallsById.has(block.id)
      ) {
        toolCallsById.set(block.id, block);
      }
    }
  }
  collectToolCalls(assistant?.content);
  for (
    let entryIndex = view.entries.length - 1;
    entryIndex >= 0 && toolCallsById.size < wantedCallIds.size;
    entryIndex -= 1
  ) {
    const messages = view.entries[entryIndex].model ?? [];
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = messages[messageIndex];
      if (message.role === "assistant") {
        collectToolCalls(message.content);
      }
    }
  }

  const tools = Object.fromEntries(
    (live?.tools ?? []).map((slot) => {
      const call = toolCallsById.get(slot.callId);
      return [
        slot.callId,
        {
          id: slot.callId,
          name: slot.name,
          args: call?.arguments ?? {},
          status:
            slot.status === "pending" ? "starting" : slot.status === "running" ? "running" : "done",
          ...(slot.output === undefined ? {} : { partialResult: slot.output }),
          ...(slot.details === undefined ? {} : { partialDetails: slot.details }),
        } satisfies PiDraftTool,
      ];
    }),
  );
  if (!assistant && Object.keys(tools).length === 0) {
    return null;
  }

  const partialContent = normalizePiContent(assistant?.content);
  const activity: PiDraftAgentActivity = Object.values(tools).some(
    (tool) => tool.status === "running",
  )
    ? "running_tools"
    : Object.keys(tools).length > 0
      ? "tool_calling"
      : partialContent.some((block) => block.type === "text" && block.text.length > 0)
        ? "writing"
        : partialContent.some((block) => block.type === "thinking" && block.thinking.length > 0)
          ? "thinking"
          : "starting";
  return {
    activity,
    ...(assistant === undefined ? {} : { assistant }),
    tools,
    appendAssistant: assistant !== undefined,
  };
}

function convertContentBlock(
  block: unknown,
  toolResultsByCallId: ReadonlyMap<string, ToolResultMessage>,
  draftToolsByCallId: ReadonlyMap<string, PiDraftTool>,
): AssistantContentBlock | null {
  const normalizedBlock = normalizePiContentBlock(block);
  if (!normalizedBlock) {
    return null;
  }

  switch (normalizedBlock.type) {
    case "text":
      return { type: "text", text: normalizedBlock.text };
    case "thinking":
      return { type: "reasoning", text: normalizedBlock.thinking };
    case "image":
      return {
        type: "image",
        image: `data:${normalizedBlock.mimeType};base64,${normalizedBlock.data}`,
      };
    case "toolCall": {
      const draftTool = draftToolsByCallId.get(normalizedBlock.id) ?? null;
      const completedToolResult =
        draftTool?.resultMessage ?? toolResultsByCallId.get(normalizedBlock.id) ?? null;
      return {
        type: "tool-call",
        toolCallId: normalizedBlock.id,
        toolName: draftTool?.name ?? normalizedBlock.name,
        args: (draftTool?.args ?? normalizedBlock.arguments) as never,
        argsText: draftTool?.argsText ?? readableJson(draftTool?.args ?? normalizedBlock.arguments),
        result: completedToolResult ?? undefined,
        isError: completedToolResult?.isError,
        artifact: { completedToolResult, draftTool } satisfies PiToolCallArtifact,
      };
    }
  }

  return null;
}

function convertDraftTool(
  tool: PiDraftTool,
  toolResultsByCallId: ReadonlyMap<string, ToolResultMessage>,
) {
  const completedToolResult = tool.resultMessage ?? toolResultsByCallId.get(tool.id) ?? null;
  return {
    type: "tool-call" as const,
    toolCallId: tool.id,
    toolName: tool.name,
    args: tool.args as never,
    argsText: tool.argsText ?? readableJson(tool.args),
    result: completedToolResult ?? undefined,
    isError: completedToolResult?.isError,
    artifact: { completedToolResult, draftTool: tool } satisfies PiToolCallArtifact,
  };
}

/** `activeContextStartMessageId` is the first rendered message of `activeContextStartIndex` on. */
export function createAssistantUiMessages({
  draftAgentMessage,
  messages,
  activeContextStartIndex,
  readyForInput,
  statusText,
}: {
  draftAgentMessage: PiDraftAgentMessage | null;
  messages: PiConversationMessage[];
  activeContextStartIndex: number | null;
  readyForInput: boolean;
  statusText: string | null;
}): { messages: ThreadMessageLike[]; activeContextStartMessageId: string | null } {
  const toolResultsByCallId = new Map<string, ToolResultMessage>();
  for (const message of messages) {
    if (message.role === "toolResult") {
      toolResultsByCallId.set(message.toolCallId, message);
    }
  }

  const draftTools = Object.values(draftAgentMessage?.tools ?? {});
  const draftToolsByCallId = new Map(draftTools.map((tool) => [tool.id, tool]));
  let lastVisibleMessageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role !== "toolResult") {
      lastVisibleMessageIndex = index;
      break;
    }
  }
  const converted: ThreadMessageLike[] = [];
  // Tool results render inside their calls, so the next message converted marks the start.
  let activeContextStartPosition: number | null = null;

  messages.forEach((message, index) => {
    if (
      activeContextStartPosition === null &&
      activeContextStartIndex !== null &&
      index >= activeContextStartIndex
    ) {
      activeContextStartPosition = converted.length;
    }
    if (message.role === "toolResult") {
      return;
    }
    if (message.role === "notification") {
      const { notification } = message;
      converted.push({
        id: `pi-notification-${notification.routeId}-${notification.event.id}`,
        role: "system",
        content: [
          {
            type: "text",
            text: readableJson({
              subject: notification.event.subject,
              payload: notification.event.payload,
            }),
          },
        ],
        createdAt: new Date(message.timestamp),
        metadata: {
          custom: { kind: "notification", notification } satisfies PiNotificationMessageMetadata,
        },
      });
      return;
    }
    if (message.role === "notification-request") {
      converted.push({
        id: `pi-notification-request-${message.timestamp}-${index}`,
        role: "system",
        content: [{ type: "text", text: notificationRequestLabel(message.notifications, "asked") }],
        createdAt: new Date(message.timestamp),
        metadata: {
          custom: {
            kind: "notification-request",
            notifications: message.notifications,
          } satisfies PiNotificationRequestMessageMetadata,
        },
      });
      return;
    }
    if (message.role === "reset") {
      converted.push({
        id: `pi-reset-${message.entryId}`,
        role: "system",
        content: [{ type: "text", text: "Context cleared" }],
        metadata: { custom: { kind: "reset" } satisfies PiResetMessageMetadata },
      });
      return;
    }
    if (message.role === "compaction") {
      converted.push({
        id: `pi-compaction-${message.timestamp}-${index}`,
        role: "system",
        content: [{ type: "text", text: message.summary }],
        createdAt: new Date(message.timestamp),
        metadata: {
          custom: {
            kind: "compaction",
            reason: message.reason,
          } satisfies PiCompactionMessageMetadata,
        },
      });
      return;
    }

    const contentBlocks = normalizePiContent("content" in message ? message.content : undefined);
    const content = contentBlocks
      .map((block) => convertContentBlock(block, toolResultsByCallId, draftToolsByCallId))
      .filter((block): block is AssistantContentBlock => block !== null);

    if (message.role === "user") {
      const attachments: PiAgentAttachment[] = [];
      const text = content.flatMap((block): AssistantContentBlock[] => {
        if (block.type !== "text") {
          return [block];
        }
        const prompt = parsePiAgentPrompt(block.text);
        attachments.push(...prompt.attachments);
        return prompt.text === "" ? [] : [{ ...block, text: prompt.text }];
      });
      converted.push({
        id: `pi-user-${message.timestamp ?? index}-${index}`,
        role: "user",
        content: text,
        createdAt: new Date(message.timestamp),
        metadata: { custom: { kind: "user", attachments } satisfies PiUserMessageMetadata },
      });
      return;
    }
    if (message.role !== "assistant") {
      return;
    }

    const shouldStream =
      index === lastVisibleMessageIndex &&
      !readyForInput &&
      draftAgentMessage?.appendAssistant !== true;
    const existingToolCallIds = new Set(
      contentBlocks.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])),
    );

    if (shouldStream) {
      for (const draftTool of draftTools) {
        if (!existingToolCallIds.has(draftTool.id)) {
          content.push(convertDraftTool(draftTool, toolResultsByCallId));
        }
      }
    }

    const visibleErrorMessage = message.stopReason === "aborted" ? undefined : message.errorMessage;
    converted.push({
      id: `pi-assistant-${message.timestamp ?? index}-${index}`,
      role: "assistant",
      content,
      createdAt: new Date(message.timestamp),
      status: shouldStream
        ? { type: "running" }
        : message.stopReason === "aborted"
          ? { type: "incomplete", reason: "cancelled" }
          : message.stopReason === "length"
            ? { type: "incomplete", reason: "length" }
            : visibleErrorMessage
              ? { type: "incomplete", reason: "error", error: visibleErrorMessage }
              : { type: "complete", reason: "stop" },
      metadata: {
        custom: {
          kind: "assistant",
          errorMessage: visibleErrorMessage ?? null,
          statusText: shouldStream ? statusText : null,
          stopReason: message.stopReason,
          usage: message.usage ? turnUsage(message.usage) : null,
          finishedAt:
            shouldStream || message.durationMs === undefined
              ? null
              : new Date(message.timestamp + message.durationMs),
          notificationRequest: null,
          notifications: [],
        } satisfies PiAssistantMessageMetadata,
      },
    });
  });

  if (activeContextStartPosition === null && activeContextStartIndex !== null) {
    activeContextStartPosition = converted.length;
  }

  const lastConvertedMessage = converted.at(-1);
  if (
    !readyForInput &&
    (lastConvertedMessage?.role !== "assistant" || draftAgentMessage?.appendAssistant === true)
  ) {
    const draftContentBlocks = normalizePiContent(draftAgentMessage?.assistant?.content);
    const draftContent: AssistantContentBlock[] = [];
    for (const block of draftContentBlocks) {
      if (block.type === "toolCall") {
        continue;
      }

      const convertedBlock = convertContentBlock(block, toolResultsByCallId, draftToolsByCallId);
      if (convertedBlock !== null) {
        draftContent.push(convertedBlock);
      }
    }
    const draftBlockToolIds = new Set(
      draftContentBlocks.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])),
    );

    for (const draftTool of draftTools) {
      if (!draftBlockToolIds.has(draftTool.id)) {
        draftContent.push(convertDraftTool(draftTool, toolResultsByCallId));
      }
    }

    // Until the response starts, when the turn started is unknown, so it shows no time.
    const startedAt = draftAgentMessage?.assistant?.timestamp;
    converted.push({
      id: `pi-assistant-draft-${startedAt ?? messages.length}`,
      role: "assistant",
      content: draftContent,
      createdAt: startedAt === undefined ? undefined : new Date(startedAt),
      status: { type: "running" },
      metadata: {
        custom: {
          kind: "assistant",
          errorMessage: null,
          statusText,
          stopReason: null,
          usage: null,
          finishedAt: null,
          notificationRequest: null,
          notifications: [],
        } satisfies PiAssistantMessageMetadata,
      },
    });
  }

  return joinAgentTurns(converted, activeContextStartPosition);
}

function turnUsage(usage: Extract<PiConversationMessage, { role: "assistant" }>["usage"]) {
  return {
    input: usage.input,
    output: usage.output,
    totalTokens: usage.totalTokens,
    cost: usage.cost.total,
  } satisfies PiTurnUsage;
}

/**
 * Joins each run of assistant messages, one per model response, into one message for the agent's
 * whole turn, so its thoughts and tool calls read as one piece of work. A turn is keyed by its
 * first response's start, which the live draft shares with the response it is persisted as, so
 * the turn keeps its identity while it streams. A run is split where the active context starts,
 * so the divider can sit between its halves.
 *
 * Delivered events go with the turn they are given to, which shows them as one line: those before
 * a request to handle them, and those delivered while it runs. Events Pi places after the turn
 * replied start a new turn of their own, so that reply still reads as one. A request joins the
 * turn that answers it, which shows it as the turn's progress and drops it when the turn says
 * nothing.
 * Events no turn takes, and a request no turn has answered yet, are one message where they are.
 */
function joinAgentTurns(
  messages: readonly ThreadMessageLike[],
  activeContextStartPosition: number | null,
): { messages: ThreadMessageLike[]; activeContextStartMessageId: string | null } {
  const joined: ThreadMessageLike[] = [];
  let activeContextStartMessageId: string | null = null;
  let turnStartPosition = activeContextStartPosition;
  let notificationRequest: PiNotificationReference[] | null = null;
  // Events delivered since the last message that took them, and when the first was.
  let delivered: { notifications: PiAgentNotification[]; at: Date | undefined } = {
    notifications: [],
    at: undefined,
  };
  const known = new Map<string, PiAgentNotification>();
  function take() {
    const taken = delivered;
    delivered = { notifications: [], at: undefined };
    return taken;
  }
  function placeDelivered(request: PiNotificationReference[] | null) {
    const { notifications, at } = take();
    if (notifications.length === 0 && request === null) {
      return;
    }
    joined.push({
      id: `pi-notifications-${joined.length}`,
      role: "system",
      content: [{ type: "text", text: notificationsLabel(notifications, request) }],
      createdAt: at,
      metadata: {
        custom: {
          kind: "notifications",
          notifications: withRequested(notifications, request, known),
          request,
        } satisfies PiNotificationsMessageMetadata,
      },
    });
  }
  messages.forEach((message, index) => {
    const previous = joined.at(-1);
    const notification = notificationOf(message);
    if (notification !== null) {
      known.set(notificationKey(notification), notification);
      delivered.notifications.push(notification);
      delivered.at ??= message.createdAt;
      if (index === turnStartPosition) {
        turnStartPosition = index + 1;
      }
      return;
    }
    const request = notificationRequestOf(message);
    if (request !== null) {
      // Events Pi places in a running turn can land between a request and its answer.
      const answer = messages.slice(index + 1).find((next) => notificationOf(next) === null);
      if (answer?.role === "assistant") {
        notificationRequest = request;
        // The answering turn stands in for the request, at the active context's start too.
        if (index === turnStartPosition) {
          turnStartPosition = index + 1;
        }
        return;
      }
      placeDelivered(request);
    } else if (
      message.role === "assistant" &&
      previous?.role === "assistant" &&
      index !== turnStartPosition &&
      notificationRequest === null &&
      !(delivered.notifications.length > 0 && previous.metadata?.custom?.stopReason === "stop")
    ) {
      const turn = joinResponses(previous, message);
      const turnMetadata = turn.metadata?.custom as PiAssistantMessageMetadata;
      joined[joined.length - 1] = {
        ...turn,
        metadata: {
          custom: {
            ...turnMetadata,
            notifications: [...turnMetadata.notifications, ...take().notifications],
          } satisfies PiAssistantMessageMetadata,
        },
      };
    } else if (message.role === "assistant") {
      const metadata = message.metadata?.custom as PiAssistantMessageMetadata;
      joined.push({
        ...message,
        // Only a turn that has not started responding has no start; there is at most one.
        id: `pi-turn-${message.createdAt?.getTime() ?? "pending"}`,
        metadata: {
          custom: {
            ...metadata,
            notificationRequest,
            notifications: withRequested(take().notifications, notificationRequest, known),
          } satisfies PiAssistantMessageMetadata,
        },
      });
      notificationRequest = null;
    } else {
      placeDelivered(null);
      joined.push(message);
    }
    if (index === turnStartPosition) {
      activeContextStartMessageId = joined.at(-1)?.id ?? null;
    }
  });
  placeDelivered(null);
  return { messages: joined, activeContextStartMessageId };
}

function notificationKey({ routeId, event }: { routeId: string | null; event: { id: string } }) {
  return `${routeId ?? ""}\n${event.id}`;
}

/** The delivered events, then those the request names that were delivered earlier, if shown. */
function withRequested(
  notifications: readonly PiAgentNotification[],
  request: readonly PiNotificationReference[] | null,
  known: ReadonlyMap<string, PiAgentNotification>,
) {
  const keys = new Set(notifications.map(notificationKey));
  const earlier = (request ?? []).flatMap(({ routeId, eventId }) => {
    const key = notificationKey({ routeId, event: { id: eventId } });
    const notification = known.get(key);
    return notification === undefined || keys.has(key) ? [] : [notification];
  });
  return [...notifications, ...earlier];
}

function notificationsLabel(
  notifications: readonly PiAgentNotification[],
  request: readonly PiNotificationReference[] | null,
) {
  if (request !== null) {
    return notificationRequestLabel(request, "asked");
  }
  return notifications.length === 1 ? "1 notification" : `${notifications.length} notifications`;
}

function notificationOf(message: ThreadMessageLike): PiAgentNotification | null {
  if (message.role !== "system") {
    return null;
  }
  const metadata = message.metadata?.custom as { kind: string };
  return metadata.kind === "notification"
    ? (metadata as PiNotificationMessageMetadata).notification
    : null;
}

function notificationRequestOf(message: ThreadMessageLike): PiNotificationReference[] | null {
  if (message.role !== "system") {
    return null;
  }
  const metadata = message.metadata?.custom as { kind: string };
  return metadata.kind === "notification-request"
    ? (metadata as PiNotificationRequestMessageMetadata).notifications
    : null;
}

function joinResponses(turn: ThreadMessageLike, response: ThreadMessageLike): ThreadMessageLike {
  const turnMetadata = turn.metadata?.custom as PiAssistantMessageMetadata;
  const responseMetadata = response.metadata?.custom as PiAssistantMessageMetadata;
  const usages = [turnMetadata.usage, responseMetadata.usage].filter(
    (usage): usage is PiTurnUsage => usage !== null,
  );
  return {
    ...response,
    id: turn.id,
    createdAt: turn.createdAt,
    content: [
      ...(turn.content as readonly AssistantContentBlock[]),
      ...(response.content as readonly AssistantContentBlock[]),
    ],
    metadata: {
      custom: {
        ...responseMetadata,
        notificationRequest: turnMetadata.notificationRequest,
        notifications: turnMetadata.notifications,
        usage:
          usages.length === 0
            ? null
            : {
                input: usages.reduce((sum, usage) => sum + usage.input, 0),
                output: usages.reduce((sum, usage) => sum + usage.output, 0),
                totalTokens: usages.reduce((sum, usage) => sum + usage.totalTokens, 0),
                cost: usages.reduce((sum, usage) => sum + usage.cost, 0),
              },
      } satisfies PiAssistantMessageMetadata,
    },
  };
}

export function getAppendMessageText(message: AppendMessage) {
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
}

/** How the composer queue labels an item. */
export type PiConversationQueueLabel =
  | "Sending"
  | "Steering"
  | "Up next"
  | "Queued"
  | "Notification";

export type PiConversationQueue = {
  items: QueueItemState[];
  /** Keyed by queue item id; Assistant UI's queue items carry only an id and a prompt. */
  labels: ReadonlyMap<string, PiConversationQueueLabel>;
};

/**
 * Projects everything waiting for the agent into Assistant UI's composer queue: first the inputs Pi
 * holds but has not placed, which placement removes, then the agent's queue in the order it runs.
 */
export function piConversationQueue(
  view: ConversationView,
  waiting: readonly PiAgentQueueEntry[],
): PiConversationQueue {
  const inbox = view.docs["pi.inbox"] as Readonly<InboxState> | undefined;
  const items: QueueItemState[] = [];
  const labels = new Map<string, PiConversationQueueLabel>();
  for (const item of inbox?.items ?? []) {
    if (item.mode === "write") {
      continue;
    }
    const id = String(item.id);
    const text =
      typeof item.content === "string"
        ? item.content
        : item.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
    const notifications = parsePiNotificationRequest(text);
    // An event that joins the running turn waits as its card.
    const event =
      item.entry?.kind === PI_NOTIFICATION_ENTRY_KIND
        ? (item.entry.data as PiAgentNotification).event
        : null;
    const prompt =
      event !== null
        ? `${event.source} · ${event.eventType}`
        : notifications
          ? notificationRequestLabel(notifications, "asked")
          : promptLabel(text);
    items.push({ id, prompt });
    labels.set(id, item.mode === "steer" ? "Steering" : "Up next");
  }
  for (const entry of waiting) {
    const id = `queue:${entry.requestId}`;
    if (entry.type === "prompt") {
      items.push({ id, prompt: promptLabel(entry.content) });
      labels.set(id, "Queued");
    } else {
      items.push({ id, prompt: `${entry.source} · ${entry.eventType}` });
      labels.set(id, "Notification");
    }
  }
  return { items, labels };
}

/** A waiting message's text, with the files it carries counted rather than listed. */
function promptLabel(prompt: string) {
  const { text, attachments } = parsePiAgentPrompt(prompt);
  if (attachments.length === 0) {
    return text;
  }
  const files = attachments.length === 1 ? "1 file" : `${attachments.length} files`;
  return text === "" ? files : `${text} · ${files}`;
}

/** How the chat names a request to handle notifications, while the agent handles them or after. */
export function notificationRequestLabel(
  notifications: readonly PiNotificationReference[],
  phase: "asked" | "handling",
) {
  const subject =
    notifications.length === 1 ? "1 notification" : `${notifications.length} notifications`;
  return phase === "handling" ? `Handling ${subject}` : `Asked to handle ${subject}`;
}
