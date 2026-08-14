import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  parseStreamingJson,
  type AssistantMessage,
  type AssistantMessageEvent,
  type StopReason,
  type ToolCall,
} from "@earendil-works/pi-ai";

export type AssistantStreamScriptMessageOptions = Partial<
  Omit<AssistantMessage, "role" | "content">
>;

type StreamingToolCall = ToolCall & { partialJson?: string };

export type AssistantStreamScriptSnapshot = AssistantMessage["content"] | AssistantMessage;

type AssistantStreamScriptBlock =
  | {
      type: "text";
      chunks: readonly string[];
      start: boolean;
      end: boolean;
      endContent?: string;
      contentIndex?: number;
      snapshots?: readonly AssistantStreamScriptSnapshot[];
    }
  | {
      type: "thinking";
      chunks: readonly string[];
      start: boolean;
      end: boolean;
      endContent?: string;
      contentIndex?: number;
      snapshots?: readonly AssistantStreamScriptSnapshot[];
    }
  | {
      type: "toolCall";
      toolCall: ToolCall;
      chunks: readonly string[];
      start: boolean;
      end: boolean;
      contentIndex?: number;
      startBlock: "empty" | "toolCall";
      snapshots?: readonly AssistantStreamScriptSnapshot[];
    };

export type AssistantStreamTextOptions = {
  chunks?: readonly string[];
  start?: boolean;
  end?: boolean;
  endContent?: string;
  contentIndex?: number;
  snapshots?: readonly AssistantStreamScriptSnapshot[];
};

export type AssistantStreamThinkingOptions = AssistantStreamTextOptions;

export type AssistantStreamToolCallOptions = {
  id: string;
  arguments: Record<string, unknown>;
  chunks?: readonly string[];
  start?: boolean;
  end?: boolean;
  contentIndex?: number;
  startBlock?: "empty" | "toolCall";
  snapshots?: readonly AssistantStreamScriptSnapshot[];
};

export type CompiledAssistantStreamScript = {
  events: readonly AssistantMessageEvent[];
  finalMessage: AssistantMessage;
  streamFn: StreamFn;
};

export type AssistantStreamHarnessEventOptions = {
  messageSnapshots?: readonly AssistantMessage[];
};

const emptyUsage: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const clone = <T>(value: T): T => structuredClone(value);

const defaultMessage = (
  content: AssistantMessage["content"],
  options: AssistantStreamScriptMessageOptions,
): AssistantMessage => ({
  role: "assistant",
  content: clone(content),
  api: "openai-responses",
  provider: "openai",
  model: "test-model",
  usage: clone(emptyUsage),
  stopReason: "stop",
  timestamp: 1,
  ...clone(options),
});

const splitText = (text: string, chunks: readonly string[] | undefined): readonly string[] =>
  chunks ?? [text];

const setContentBlock = (
  content: AssistantMessage["content"],
  contentIndex: number,
  block: AssistantMessage["content"][number],
): void => {
  content[contentIndex] = clone(block);
};

const messageSnapshot = (
  content: AssistantMessage["content"],
  snapshots: readonly AssistantStreamScriptSnapshot[] | undefined,
  eventIndex: number,
  messageOptions: AssistantStreamScriptMessageOptions,
): AssistantMessage => {
  const snapshot = snapshots?.[eventIndex];
  return snapshot && !Array.isArray(snapshot)
    ? clone(snapshot)
    : defaultMessage(snapshot ?? content, messageOptions);
};

const streamFromEvents =
  (events: readonly AssistantMessageEvent[], finalMessage: AssistantMessage): StreamFn =>
  () => {
    const stream = createAssistantMessageEventStream();
    for (const event of events) {
      stream.push(clone(event));
    }
    if (!events.some((event) => event.type === "done" || event.type === "error")) {
      stream.end(clone(finalMessage));
    }
    return stream;
  };

export class AssistantStreamScript {
  readonly #blocks: AssistantStreamScriptBlock[] = [];
  #startContent: AssistantMessage["content"] = [];
  #messageOptions: AssistantStreamScriptMessageOptions = {};
  #finalContent: AssistantMessage["content"] | undefined;
  #finalMessageOptions: AssistantStreamScriptMessageOptions = {};
  #terminal:
    | { type: "done"; reason: Exclude<StopReason, "error" | "aborted"> }
    | {
        type: "error";
        reason: Extract<StopReason, "error" | "aborted">;
        errorMessage: string;
      } = { type: "done", reason: "stop" };

  message(options: AssistantStreamScriptMessageOptions): this {
    this.#messageOptions = { ...this.#messageOptions, ...clone(options) };
    return this;
  }

  startsWith(content: AssistantMessage["content"]): this {
    this.#startContent = clone(content);
    return this;
  }

  text(text: string, options: AssistantStreamTextOptions = {}): this {
    this.#blocks.push({
      type: "text",
      chunks: splitText(text, options.chunks),
      start: options.start ?? true,
      end: options.end ?? true,
      endContent: options.endContent,
      contentIndex: options.contentIndex,
      snapshots: options.snapshots ? clone(options.snapshots) : undefined,
    });
    return this;
  }

  thinking(thinking: string, options: AssistantStreamThinkingOptions = {}): this {
    this.#blocks.push({
      type: "thinking",
      chunks: splitText(thinking, options.chunks),
      start: options.start ?? true,
      end: options.end ?? true,
      endContent: options.endContent,
      contentIndex: options.contentIndex,
      snapshots: options.snapshots ? clone(options.snapshots) : undefined,
    });
    return this;
  }

  toolCall(name: string, options: AssistantStreamToolCallOptions): this {
    this.#blocks.push({
      type: "toolCall",
      toolCall: { type: "toolCall", id: options.id, name, arguments: clone(options.arguments) },
      chunks: options.chunks ?? [JSON.stringify(options.arguments)],
      start: options.start ?? true,
      end: options.end ?? true,
      contentIndex: options.contentIndex,
      startBlock: options.startBlock ?? "toolCall",
      snapshots: options.snapshots ? clone(options.snapshots) : undefined,
    });
    return this;
  }

  completes(
    reason: Exclude<StopReason, "error" | "aborted"> = "stop",
    options: {
      content?: AssistantMessage["content"];
      message?: AssistantStreamScriptMessageOptions;
    } = {},
  ): this {
    this.#terminal = { type: "done", reason };
    this.#finalContent = options.content ? clone(options.content) : undefined;
    this.#finalMessageOptions = clone(options.message ?? {});
    return this;
  }

  fails(
    errorMessage: string,
    options: {
      reason?: Extract<StopReason, "error" | "aborted">;
      content?: AssistantMessage["content"];
      message?: AssistantStreamScriptMessageOptions;
    } = {},
  ): this {
    this.#terminal = { type: "error", reason: options.reason ?? "error", errorMessage };
    this.#finalContent = options.content ? clone(options.content) : undefined;
    this.#finalMessageOptions = clone(options.message ?? {});
    return this;
  }

  compile(): CompiledAssistantStreamScript {
    const events: AssistantMessageEvent[] = [];
    const content = clone(this.#startContent);
    const startMessage = defaultMessage(content, this.#messageOptions);
    events.push({ type: "start", partial: clone(startMessage) });

    let nextContentIndex = content.length;
    for (const block of this.#blocks) {
      const contentIndex = block.contentIndex ?? nextContentIndex;
      nextContentIndex = Math.max(nextContentIndex, contentIndex + 1);
      let eventIndex = 0;
      const snapshot = () =>
        messageSnapshot(content, block.snapshots, eventIndex++, this.#messageOptions);

      if (block.type === "text") {
        if (block.start) {
          setContentBlock(content, contentIndex, { type: "text", text: "" });
          events.push({ type: "text_start", contentIndex, partial: snapshot() });
        }
        for (const delta of block.chunks) {
          const current = content[contentIndex];
          if (current?.type === "text") {
            current.text += delta;
          }
          events.push({ type: "text_delta", contentIndex, delta, partial: snapshot() });
        }
        if (block.end) {
          const current = content[contentIndex];
          const endContent =
            block.endContent ?? (current?.type === "text" ? current.text : block.chunks.join(""));
          events.push({ type: "text_end", contentIndex, content: endContent, partial: snapshot() });
        }
        continue;
      }

      if (block.type === "thinking") {
        if (block.start) {
          setContentBlock(content, contentIndex, { type: "thinking", thinking: "" });
          events.push({ type: "thinking_start", contentIndex, partial: snapshot() });
        }
        for (const delta of block.chunks) {
          const current = content[contentIndex];
          if (current?.type === "thinking") {
            current.thinking += delta;
          }
          events.push({ type: "thinking_delta", contentIndex, delta, partial: snapshot() });
        }
        if (block.end) {
          const current = content[contentIndex];
          const endContent =
            block.endContent ??
            (current?.type === "thinking" ? current.thinking : block.chunks.join(""));
          events.push({
            type: "thinking_end",
            contentIndex,
            content: endContent,
            partial: snapshot(),
          });
        }
        continue;
      }

      const partialToolCall: StreamingToolCall = {
        type: "toolCall",
        id: block.toolCall.id,
        name: block.toolCall.name,
        arguments: {},
        partialJson: "",
      };
      if (block.start && block.startBlock === "toolCall") {
        setContentBlock(content, contentIndex, partialToolCall);
      }
      if (block.start) {
        events.push({ type: "toolcall_start", contentIndex, partial: snapshot() });
      }
      for (const delta of block.chunks) {
        partialToolCall.partialJson = `${partialToolCall.partialJson ?? ""}${delta}`;
        partialToolCall.arguments = parseStreamingJson(partialToolCall.partialJson);
        if (content[contentIndex]?.type === "toolCall") {
          setContentBlock(content, contentIndex, partialToolCall);
        }
        events.push({ type: "toolcall_delta", contentIndex, delta, partial: snapshot() });
      }
      if (block.end) {
        setContentBlock(content, contentIndex, block.toolCall);
        events.push({
          type: "toolcall_end",
          contentIndex,
          toolCall: clone(block.toolCall),
          partial: snapshot(),
        });
      }
    }

    const finalContent = this.#finalContent ?? content;
    const finalMessageOptions = {
      ...this.#messageOptions,
      ...this.#finalMessageOptions,
      stopReason: this.#terminal.reason,
      ...(this.#terminal.type === "error" ? { errorMessage: this.#terminal.errorMessage } : {}),
    };
    const finalMessage = defaultMessage(finalContent, finalMessageOptions);
    if (this.#terminal.type === "done") {
      events.push({ type: "done", reason: this.#terminal.reason, message: clone(finalMessage) });
    } else {
      events.push({ type: "error", reason: this.#terminal.reason, error: clone(finalMessage) });
    }

    return {
      events: clone(events),
      finalMessage: clone(finalMessage),
      streamFn: streamFromEvents(events, finalMessage),
    };
  }

  harnessEvents(options: AssistantStreamHarnessEventOptions = {}): PiHarnessAssistantStreamEvent[] {
    const { events } = this.compile();
    let messageSnapshotIndex = 0;
    const harnessEvents: PiHarnessAssistantStreamEvent[] = [];

    for (const event of events) {
      switch (event.type) {
        case "start":
          harnessEvents.push({ type: "message_start", message: clone(event.partial) });
          break;
        case "text_start":
        case "text_delta":
        case "text_end":
        case "thinking_start":
        case "thinking_delta":
        case "thinking_end":
        case "toolcall_start":
        case "toolcall_delta":
        case "toolcall_end":
          harnessEvents.push({
            type: "message_update",
            message: clone(options.messageSnapshots?.[messageSnapshotIndex++] ?? event.partial),
            assistantMessageEvent: clone(event),
          });
          break;
        case "done":
          harnessEvents.push({ type: "message_end", message: clone(event.message) });
          break;
        case "error":
          harnessEvents.push({ type: "message_end", message: clone(event.error) });
          break;
      }
    }

    return harnessEvents;
  }
}

export type PiHarnessAssistantStreamEvent =
  | { type: "message_start"; message: AssistantMessage }
  | {
      type: "message_update";
      message: AssistantMessage;
      assistantMessageEvent: Exclude<AssistantMessageEvent, { type: "start" | "done" | "error" }>;
    }
  | { type: "message_end"; message: AssistantMessage };

export const createAssistantStreamScript = (): AssistantStreamScript => new AssistantStreamScript();
