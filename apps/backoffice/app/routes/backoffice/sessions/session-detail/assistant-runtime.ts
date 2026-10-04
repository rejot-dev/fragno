import type { AppendMessage, ThreadMessageLike } from "@assistant-ui/react";
import type { Message as PiDurableMessage } from "@earendil-works/pi-ai";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";

export type PiConversationMessage = PiDurableMessage;
export type ToolResultMessage = Extract<PiConversationMessage, { role: "toolResult" }>;
export type PiDraftTool = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  argsText?: string;
  status: "starting" | "running" | "done";
  partialResult?: unknown;
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
  assistant?: Extract<PiConversationMessage, { role: "assistant" }>;
  tools: Record<string, PiDraftTool>;
  startedAt: number;
  updatedAt: number;
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

export type PiAssistantMessageMetadata = {
  kind?: "assistant";
  errorMessage?: string;
  statusText?: string | null;
  stopReason?: Extract<PiConversationMessage, { role: "assistant" }>["stopReason"];
  usage?: Extract<PiConversationMessage, { role: "assistant" }>["usage"];
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

/** Hides superseded recovery partials while preserving distinct attempts and completed tool rounds. */
export function piConversationMessages(view: ConversationView): PiConversationMessage[] {
  const completedAssistantAttempts = new Set<string>();
  for (const entry of view.entries) {
    const taskKey = entry.byTaskId === undefined ? `entry:${entry.id}` : `task:${entry.byTaskId}`;
    for (const message of entry.model ?? []) {
      if (message.role === "assistant" && message.stopReason !== "aborted") {
        completedAssistantAttempts.add(`${taskKey}:${assistantRecoveryFingerprint(message)}`);
      }
    }
  }

  const visibleAbortedAttempts = new Set<string>();
  return view.entries.flatMap((entry) => {
    const taskKey = entry.byTaskId === undefined ? `entry:${entry.id}` : `task:${entry.byTaskId}`;
    return (entry.model ?? []).filter((message) => {
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
  });
}

/** Projects Pi's committed live document into the existing Assistant UI draft model. */
export function piConversationDraftAgentMessage(
  view: ConversationView,
): PiDraftAgentMessage | null {
  const live = view.docs["pi.live"] as Readonly<LiveState> | undefined;
  const assistant = live?.generation?.message as
    | Extract<PiConversationMessage, { role: "assistant" }>
    | undefined;
  const toolCallsById = new Map<string, Extract<PiContentBlock, { type: "toolCall" }>>();
  for (const entry of view.entries) {
    for (const message of entry.model ?? []) {
      if (message.role !== "assistant") {
        continue;
      }
      for (const block of normalizePiContent(message.content)) {
        if (block.type === "toolCall") {
          toolCallsById.set(block.id, block);
        }
      }
    }
  }
  for (const block of normalizePiContent(assistant?.content)) {
    if (block.type === "toolCall") {
      toolCallsById.set(block.id, block);
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
  const timestamp = assistant?.timestamp ?? 0;
  return {
    activity,
    ...(assistant === undefined ? {} : { assistant }),
    tools,
    startedAt: timestamp,
    updatedAt: timestamp,
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

const messageDate = (timestamp: number | undefined, fallbackIndex: number) =>
  new Date(timestamp ?? fallbackIndex);

export function createAssistantUiMessages({
  draftAgentMessage,
  messages,
  readyForInput,
  statusText,
}: {
  draftAgentMessage: PiDraftAgentMessage | null;
  messages: PiConversationMessage[];
  readyForInput: boolean;
  statusText: string | null;
}): ThreadMessageLike[] {
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

  messages.forEach((message, index) => {
    if (message.role === "toolResult") {
      return;
    }

    const contentBlocks = normalizePiContent("content" in message ? message.content : undefined);
    const content = contentBlocks
      .map((block) => convertContentBlock(block, toolResultsByCallId, draftToolsByCallId))
      .filter((block): block is AssistantContentBlock => block !== null);

    if (message.role === "user") {
      converted.push({
        id: `pi-user-${message.timestamp ?? index}-${index}`,
        role: "user",
        content,
        createdAt: messageDate(message.timestamp, index),
        metadata: { custom: {} },
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
      createdAt: messageDate(message.timestamp, index),
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
          errorMessage: visibleErrorMessage,
          statusText: shouldStream ? statusText : null,
          stopReason: message.stopReason,
          usage: message.usage,
        } satisfies PiAssistantMessageMetadata,
      },
    });
  });

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

    converted.push({
      id: `pi-assistant-draft-${draftAgentMessage?.startedAt ?? messages.length}`,
      role: "assistant",
      content: draftContent,
      createdAt: messageDate(draftAgentMessage?.startedAt, messages.length),
      status: { type: "running" },
      metadata: {
        custom: { statusText } satisfies PiAssistantMessageMetadata,
      },
    });
  }

  return converted;
}

export function getAppendMessageText(message: AppendMessage) {
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
}
