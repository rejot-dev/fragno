import type { AgentHarnessEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai";

export interface PiHarnessEventStreamEncoder<TEncodedEvent> {
  encode(event: AgentHarnessEvent): TEncodedEvent;
}

export type PiHarnessProjectedEvent = {
  readonly type: AgentHarnessEvent["type"];
};

export type PiHarnessFrontendToolCall = Omit<ToolCall, "thoughtSignature">;

export type PiHarnessFrontendAssistantContent =
  | Omit<Extract<AssistantMessage["content"][number], { type: "text" }>, "textSignature">
  | Omit<Extract<AssistantMessage["content"][number], { type: "thinking" }>, "thinkingSignature">
  | PiHarnessFrontendToolCall;

export type PiHarnessFrontendAssistantMessage = Omit<
  AssistantMessage,
  "api" | "provider" | "model" | "responseModel" | "responseId" | "diagnostics" | "content"
> & {
  readonly content: PiHarnessFrontendAssistantContent[];
};

export type PiHarnessFrontendMessage<TMessage> = TMessage extends AssistantMessage
  ? PiHarnessFrontendAssistantMessage
  : TMessage;

export type PiHarnessFrontendAgentMessage = PiHarnessFrontendMessage<AgentMessage>;

type PiHarnessFrontendAssistantMessageEvent<TEvent> = TEvent extends {
  partial: AssistantMessage;
}
  ? Omit<TEvent, "partial" | "toolCall"> & {
      readonly partial: PiHarnessFrontendAssistantMessage;
    } & (TEvent extends { toolCall: ToolCall }
        ? { readonly toolCall: PiHarnessFrontendToolCall }
        : object)
  : TEvent;

type PiHarnessFrontendEventFields<TEvent> = {
  readonly [TKey in keyof TEvent]: TKey extends "message"
    ? PiHarnessFrontendMessage<TEvent[TKey]>
    : TKey extends
          | "messages"
          | "toolResults"
          | "steer"
          | "followUp"
          | "nextTurn"
          | "clearedSteer"
          | "clearedFollowUp"
      ? TEvent[TKey] extends readonly (infer TMessage)[]
        ? PiHarnessFrontendMessage<TMessage>[]
        : TEvent[TKey]
      : TKey extends "assistantMessageEvent"
        ? PiHarnessFrontendAssistantMessageEvent<TEvent[TKey]>
        : TEvent[TKey];
};

/** The frontend projection preserves every event while omitting provider-owned message metadata. */
export type PiHarnessFrontendEvent = AgentHarnessEvent extends infer TEvent
  ? TEvent extends PiHarnessProjectedEvent
    ? PiHarnessFrontendEventFields<TEvent>
    : never
  : never;

export interface PiHarnessEventStreamDecoder<TEncodedEvent> {
  decode(event: TEncodedEvent): PiHarnessFrontendEvent;
}

/** Projects each AgentHarness event into one frontend-safe event with the same event type. */
export interface PiHarnessEventProtocol {
  createEncoder(): PiHarnessEventStreamEncoder<unknown>;
  createDecoder(): PiHarnessEventStreamDecoder<unknown>;
  eventType(event: unknown): PiHarnessFrontendEvent["type"];
}

export const piToolCallArgumentsText = (toolCall: ToolCall): string | undefined => {
  const partialJson = (toolCall as ToolCall & { partialJson?: unknown }).partialJson;
  return typeof partialJson === "string" ? partialJson : undefined;
};

import {
  assertPiHarnessJsonValue,
  freezePiHarnessJsonValue,
  snapshotPiHarnessJsonValue,
} from "./json-value";

export type PiHarnessSubscribedEvent = Exclude<
  AgentHarnessEvent,
  | { type: "before_agent_start" }
  | { type: "context" }
  | { type: "before_provider_request" }
  | { type: "before_provider_payload" }
  | { type: "tool_call" }
  | { type: "tool_result" }
  | { type: "session_before_compact" }
  | { type: "session_before_tree" }
>;

type EncodedValue<TValue = unknown> =
  | { readonly kind: "value"; readonly id: number; readonly value: TValue }
  | { readonly kind: "reference"; readonly id: number };

type ProjectedAgentMessage =
  | Exclude<AgentMessage, AssistantMessage>
  | PiHarnessFrontendAssistantMessage;

type EncodedMessage =
  | {
      readonly kind: "message";
      readonly id: number;
      readonly message: ProjectedAgentMessage;
    }
  | { readonly kind: "reference"; readonly id: number };

type StreamedAssistantMessageEvent = Exclude<
  AssistantMessageEvent,
  { type: "start" | "done" | "error" }
>;
type ProjectedMessageUpdateEvent = Extract<
  PiHarnessFrontendEvent,
  { type: "message_update" }
>["assistantMessageEvent"];

type AssistantTextContent = Extract<AssistantMessage["content"][number], { type: "text" }>;
type AssistantThinkingContent = Extract<AssistantMessage["content"][number], { type: "thinking" }>;
type ProjectedAssistantMessage = PiHarnessFrontendAssistantMessage;

type CompactContentTransition =
  | { readonly kind: "append"; readonly content: string }
  | { readonly kind: "replace"; readonly content: string };

type CompactAssistantMessageEvent =
  | {
      readonly type: "text_start";
      readonly contentIndex: number;
      readonly text: string;
    }
  | {
      readonly type: "text_delta";
      readonly contentIndex: number;
      readonly delta: string;
      readonly contentTransition: CompactContentTransition;
    }
  | {
      readonly type: "text_end";
      readonly contentIndex: number;
      readonly content: string;
      readonly text: string;
    }
  | {
      readonly type: "thinking_start";
      readonly contentIndex: number;
      readonly thinking: string;
      readonly redacted?: boolean;
    }
  | {
      readonly type: "thinking_delta";
      readonly contentIndex: number;
      readonly delta: string;
      readonly contentTransition: CompactContentTransition;
      readonly redacted?: boolean;
    }
  | {
      readonly type: "thinking_end";
      readonly contentIndex: number;
      readonly content: string;
      readonly thinking: string;
      readonly redacted?: boolean;
    }
  | {
      readonly type: "toolcall_start";
      readonly contentIndex: number;
      readonly toolCall: PiHarnessFrontendToolCall;
    }
  | {
      readonly type: "toolcall_delta";
      readonly contentIndex: number;
      readonly delta: string;
      readonly toolCall: PiHarnessFrontendToolCall;
    }
  | {
      readonly type: "toolcall_end";
      readonly contentIndex: number;
      readonly toolCall: PiHarnessFrontendToolCall;
      readonly partialToolCall: PiHarnessFrontendToolCall;
    };

type CompactAssistantMessageMetadataUpdate = {
  readonly usage?: AssistantMessage["usage"];
  readonly stopReason?: AssistantMessage["stopReason"];
  readonly errorMessage?: string | null;
  readonly timestamp?: number;
};

type CompactMessageUpdate = {
  readonly type: "message_update";
  readonly update: CompactAssistantMessageEvent;
  readonly metadata?: CompactAssistantMessageMetadataUpdate;
};

export type PiHarnessCompactEvent =
  | { readonly type: "raw"; readonly event: PiHarnessSubscribedEvent }
  | { readonly type: "agent_start" }
  | { readonly type: "agent_end"; readonly messages: readonly EncodedMessage[] }
  | { readonly type: "turn_start" }
  | {
      readonly type: "turn_end";
      readonly message: EncodedMessage;
      readonly toolResults: readonly EncodedMessage[];
    }
  | { readonly type: "message_start"; readonly message: EncodedMessage }
  | CompactMessageUpdate
  | { readonly type: "message_end"; readonly message: EncodedMessage }
  | {
      readonly type: "tool_execution_start";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: EncodedValue;
    }
  | {
      readonly type: "tool_execution_update";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: EncodedValue;
      readonly partialResult: EncodedValue;
    }
  | {
      readonly type: "tool_execution_end";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly result: EncodedValue;
      readonly isError: boolean;
    }
  | {
      readonly type: "queue_update";
      readonly steer: readonly EncodedMessage[];
      readonly followUp: readonly EncodedMessage[];
      readonly nextTurn: readonly EncodedMessage[];
    }
  | { readonly type: "save_point"; readonly hadPendingMutations: boolean }
  | {
      readonly type: "abort";
      readonly clearedSteer: readonly EncodedMessage[];
      readonly clearedFollowUp: readonly EncodedMessage[];
    }
  | { readonly type: "settled"; readonly nextTurnCount: number }
  | {
      readonly type: "after_provider_response";
      readonly status: number;
      readonly headers: EncodedValue<SubscribedEvent<"after_provider_response">["headers"]>;
    }
  | {
      readonly type: "session_compact";
      readonly compactionEntry: EncodedValue<SubscribedEvent<"session_compact">["compactionEntry"]>;
      readonly fromHook: boolean;
    }
  | {
      readonly type: "session_tree";
      readonly newLeafId: string | null;
      readonly oldLeafId: string | null;
      readonly summaryEntry?: EncodedValue<
        NonNullable<SubscribedEvent<"session_tree">["summaryEntry"]>
      >;
      readonly fromHook?: boolean;
    }
  | {
      readonly type: "retry_scheduled";
      readonly operation: "compaction" | "branch_summary";
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
      readonly errorMessage: string;
    }
  | {
      readonly type: "retry_attempt_start" | "retry_finished";
      readonly operation: "compaction" | "branch_summary";
    }
  | {
      readonly type: "model_update";
      readonly model: EncodedValue<SubscribedEvent<"model_update">["model"]>;
      readonly previousModel?: EncodedValue<
        NonNullable<SubscribedEvent<"model_update">["previousModel"]>
      >;
      readonly source: "set" | "restore";
    }
  | {
      readonly type: "thinking_level_update";
      readonly level: SubscribedEvent<"thinking_level_update">["level"];
      readonly previousLevel: SubscribedEvent<"thinking_level_update">["previousLevel"];
    }
  | {
      readonly type: "tools_update";
      readonly toolNames: readonly string[];
      readonly previousToolNames: readonly string[];
      readonly activeToolNames: readonly string[];
      readonly previousActiveToolNames: readonly string[];
      readonly source: "set" | "restore";
    }
  | {
      readonly type: "resources_update";
      readonly resources: EncodedValue<SubscribedEvent<"resources_update">["resources"]>;
      readonly previousResources: EncodedValue<
        SubscribedEvent<"resources_update">["previousResources"]
      >;
    };

type SubscribedEvent<TType extends PiHarnessSubscribedEvent["type"]> = Extract<
  PiHarnessSubscribedEvent,
  { type: TType }
>;

const compactAssistantMessageMetadataUpdate = (
  previous: ProjectedAssistantMessage,
  next: AssistantMessage,
): CompactAssistantMessageMetadataUpdate | undefined => {
  const update: CompactAssistantMessageMetadataUpdate = {
    ...(previous.usage.input === next.usage.input &&
    previous.usage.output === next.usage.output &&
    previous.usage.cacheRead === next.usage.cacheRead &&
    previous.usage.cacheWrite === next.usage.cacheWrite &&
    previous.usage.cacheWrite1h === next.usage.cacheWrite1h &&
    previous.usage.reasoning === next.usage.reasoning &&
    previous.usage.totalTokens === next.usage.totalTokens &&
    previous.usage.cost.input === next.usage.cost.input &&
    previous.usage.cost.output === next.usage.cost.output &&
    previous.usage.cost.cacheRead === next.usage.cost.cacheRead &&
    previous.usage.cost.cacheWrite === next.usage.cost.cacheWrite &&
    previous.usage.cost.total === next.usage.cost.total
      ? {}
      : { usage: next.usage }),
    ...(previous.stopReason === next.stopReason ? {} : { stopReason: next.stopReason }),
    ...(previous.errorMessage === next.errorMessage
      ? {}
      : { errorMessage: next.errorMessage ?? null }),
    ...(previous.timestamp === next.timestamp ? {} : { timestamp: next.timestamp }),
  };

  return Object.keys(update).length === 0 ? undefined : update;
};

const assistantMessageWithMetadataUpdate = (
  message: ProjectedAssistantMessage,
  update: CompactAssistantMessageMetadataUpdate,
): ProjectedAssistantMessage => ({
  ...message,
  ...(update.usage === undefined ? {} : { usage: update.usage }),
  ...(update.stopReason === undefined ? {} : { stopReason: update.stopReason }),
  ...(update.errorMessage === undefined
    ? {}
    : update.errorMessage === null
      ? { errorMessage: undefined }
      : { errorMessage: update.errorMessage }),
  ...(update.timestamp === undefined ? {} : { timestamp: update.timestamp }),
});

const streamedMessageUpdateEvent = (
  event: AssistantMessageEvent,
): StreamedAssistantMessageEvent => {
  switch (event.type) {
    case "start":
    case "done":
    case "error":
      throw new Error("PI_HARNESS_EVENT_PROTOCOL_NON_STREAMING_MESSAGE_UPDATE");
    case "text_start":
    case "text_delta":
    case "text_end":
    case "thinking_start":
    case "thinking_delta":
    case "thinking_end":
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
      return event;
  }

  throw new Error("PI_HARNESS_EVENT_PROTOCOL_UNKNOWN_MESSAGE_UPDATE");
};

const textContentFromPartial = (
  event: Extract<StreamedAssistantMessageEvent, { type: "text_start" | "text_delta" | "text_end" }>,
): AssistantTextContent => {
  const content = event.partial.content[event.contentIndex];
  if (content?.type !== "text") {
    throw new Error("PI_HARNESS_EVENT_PROTOCOL_TEXT_UPDATE_WITHOUT_TEXT_BLOCK");
  }
  return content;
};

const thinkingContentFromPartial = (
  event: Extract<
    StreamedAssistantMessageEvent,
    { type: "thinking_start" | "thinking_delta" | "thinking_end" }
  >,
): AssistantThinkingContent => {
  const content = event.partial.content[event.contentIndex];
  if (content?.type !== "thinking") {
    throw new Error("PI_HARNESS_EVENT_PROTOCOL_THINKING_UPDATE_WITHOUT_THINKING_BLOCK");
  }
  return content;
};

const toolCallFromPartial = (
  event: Extract<
    StreamedAssistantMessageEvent,
    { type: "toolcall_start" | "toolcall_delta" | "toolcall_end" }
  >,
): ToolCall => {
  const content = event.partial.content[event.contentIndex];
  if (content?.type !== "toolCall") {
    throw new Error("PI_HARNESS_EVENT_PROTOCOL_TOOL_CALL_UPDATE_WITHOUT_TOOL_CALL_BLOCK");
  }
  return content;
};

const thinkingMetadataFields = (
  content: AssistantThinkingContent,
): Pick<AssistantThinkingContent, "redacted"> =>
  content.redacted === undefined ? {} : { redacted: content.redacted };

const projectToolCall = ({
  thoughtSignature: _thoughtSignature,
  ...toolCall
}: ToolCall): PiHarnessFrontendToolCall => toolCall;

const projectAssistantMessage = ({
  api: _api,
  provider: _provider,
  model: _model,
  responseModel: _responseModel,
  responseId: _responseId,
  diagnostics: _diagnostics,
  content,
  ...message
}: AssistantMessage): ProjectedAssistantMessage => ({
  ...message,
  content: content.map((block) => {
    switch (block.type) {
      case "text": {
        const { textSignature: _textSignature, ...text } = block;
        return text;
      }
      case "thinking": {
        const { thinkingSignature: _thinkingSignature, ...thinking } = block;
        return thinking;
      }
      case "toolCall":
        return projectToolCall(block);
    }

    throw new Error("PI_HARNESS_FRONTEND_PROTOCOL_UNKNOWN_ASSISTANT_CONTENT");
  }),
});

const projectAgentMessage = (message: AgentMessage): ProjectedAgentMessage =>
  message.role === "assistant" ? projectAssistantMessage(message) : message;

const compactContentTransition = (
  previousContent: string | undefined,
  content: string,
): CompactContentTransition =>
  previousContent !== undefined && content.startsWith(previousContent)
    ? { kind: "append", content: content.slice(previousContent.length) }
    : { kind: "replace", content };

const assertAssistantContentIndexIsNotSparse = (
  event: StreamedAssistantMessageEvent,
  previousMessage: ProjectedAssistantMessage,
): void => {
  if (event.contentIndex > previousMessage.content.length) {
    throw new Error(`PI_HARNESS_EVENT_PROTOCOL_SPARSE_CONTENT_INDEX:${event.contentIndex}`);
  }
};

const compactAssistantMessageEvent = (
  event: StreamedAssistantMessageEvent,
  previousMessage: ProjectedAssistantMessage,
): CompactAssistantMessageEvent => {
  assertAssistantContentIndexIsNotSparse(event, previousMessage);

  switch (event.type) {
    case "text_start": {
      const content = textContentFromPartial(event);
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        text: content.text,
      };
    }
    case "text_delta": {
      const content = textContentFromPartial(event);
      const previousContent = previousMessage.content[event.contentIndex];
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        delta: event.delta,
        contentTransition: compactContentTransition(
          previousContent?.type === "text" ? previousContent.text : undefined,
          content.text,
        ),
      };
    }
    case "text_end": {
      const content = textContentFromPartial(event);
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        content: event.content,
        text: content.text,
      };
    }
    case "thinking_start": {
      const content = thinkingContentFromPartial(event);
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        thinking: content.thinking,
        ...thinkingMetadataFields(content),
      };
    }
    case "thinking_delta": {
      const content = thinkingContentFromPartial(event);
      const previousContent = previousMessage.content[event.contentIndex];
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        delta: event.delta,
        contentTransition: compactContentTransition(
          previousContent?.type === "thinking" ? previousContent.thinking : undefined,
          content.thinking,
        ),
        ...thinkingMetadataFields(content),
      };
    }
    case "thinking_end": {
      const content = thinkingContentFromPartial(event);
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        content: event.content,
        thinking: content.thinking,
        ...thinkingMetadataFields(content),
      };
    }
    case "toolcall_start":
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        toolCall: projectToolCall(toolCallFromPartial(event)),
      };
    case "toolcall_delta":
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        delta: event.delta,
        toolCall: projectToolCall(toolCallFromPartial(event)),
      };
    case "toolcall_end":
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        toolCall: projectToolCall(event.toolCall),
        partialToolCall: projectToolCall(toolCallFromPartial(event)),
      };
  }

  throw new Error("PI_HARNESS_EVENT_PROTOCOL_UNKNOWN_STREAMING_MESSAGE_UPDATE");
};

const streamedAssistantMessageEvent = (
  update: CompactAssistantMessageEvent,
  partial: ProjectedAssistantMessage,
): ProjectedMessageUpdateEvent => {
  switch (update.type) {
    case "text_start":
    case "thinking_start":
    case "toolcall_start":
      return { type: update.type, contentIndex: update.contentIndex, partial };
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return {
        type: update.type,
        contentIndex: update.contentIndex,
        delta: update.delta,
        partial,
      };
    case "text_end":
    case "thinking_end":
      return {
        type: update.type,
        contentIndex: update.contentIndex,
        content: update.content,
        partial,
      };
    case "toolcall_end":
      return {
        type: update.type,
        contentIndex: update.contentIndex,
        toolCall: update.toolCall,
        partial,
      };
  }

  throw new Error("PI_HARNESS_EVENT_PROTOCOL_UNKNOWN_COMPACT_MESSAGE_UPDATE");
};

const applyCompactContentTransition = (
  content: string,
  transition: CompactContentTransition,
): string => (transition.kind === "append" ? content + transition.content : transition.content);

const applyCompactAssistantMessageEvent = (
  message: ProjectedAssistantMessage,
  update: CompactAssistantMessageEvent,
): void => {
  switch (update.type) {
    case "text_start":
      message.content[update.contentIndex] = {
        type: "text",
        text: update.text,
      };
      return;
    case "text_delta": {
      const content = message.content[update.contentIndex];
      if (content?.type !== "text") {
        throw new Error("PI_HARNESS_EVENT_PROTOCOL_TEXT_DELTA_WITHOUT_TEXT_BLOCK");
      }
      message.content[update.contentIndex] = {
        type: "text",
        text: applyCompactContentTransition(content.text, update.contentTransition),
      };
      return;
    }
    case "text_end":
      message.content[update.contentIndex] = {
        type: "text",
        text: update.text,
      };
      return;
    case "thinking_start":
      message.content[update.contentIndex] = {
        type: "thinking",
        thinking: update.thinking,
        ...(update.redacted === undefined ? {} : { redacted: update.redacted }),
      };
      return;
    case "thinking_delta": {
      const content = message.content[update.contentIndex];
      if (content?.type !== "thinking") {
        throw new Error("PI_HARNESS_EVENT_PROTOCOL_THINKING_DELTA_WITHOUT_THINKING_BLOCK");
      }
      message.content[update.contentIndex] = {
        type: "thinking",
        thinking: applyCompactContentTransition(content.thinking, update.contentTransition),
        ...(update.redacted === undefined ? {} : { redacted: update.redacted }),
      };
      return;
    }
    case "thinking_end":
      message.content[update.contentIndex] = {
        type: "thinking",
        thinking: update.thinking,
        ...(update.redacted === undefined ? {} : { redacted: update.redacted }),
      };
      return;
    case "toolcall_start":
    case "toolcall_delta":
      message.content[update.contentIndex] = update.toolCall;
      return;
    case "toolcall_end":
      message.content[update.contentIndex] = update.partialToolCall;
  }
};

class ValueEncoder {
  readonly #idsByValue = new Map<unknown, number>();

  encode<TValue>(value: TValue): EncodedValue<TValue> {
    const existingId = this.#idsByValue.get(value);
    if (existingId !== undefined) {
      return { kind: "reference", id: existingId };
    }

    const id = this.#idsByValue.size;
    this.#idsByValue.set(value, id);
    return { kind: "value", id, value };
  }
}

class ValueDecoder {
  readonly #valuesById = new Map<number, unknown>();

  decode<TValue>(encoded: EncodedValue<TValue>): TValue {
    if (encoded.kind === "value") {
      this.#valuesById.set(encoded.id, encoded.value);
      return encoded.value;
    }

    if (!this.#valuesById.has(encoded.id)) {
      throw new Error(`PI_HARNESS_EVENT_PROTOCOL_UNKNOWN_VALUE_REFERENCE:${encoded.id}`);
    }
    return this.#valuesById.get(encoded.id) as TValue;
  }
}

class MessageEncoder {
  readonly #idsByMessage = new Map<AgentMessage, number>();

  encode(message: AgentMessage): EncodedMessage {
    const existingId = this.#idsByMessage.get(message);
    if (existingId !== undefined) {
      return { kind: "reference", id: existingId };
    }

    const id = this.#idsByMessage.size;
    this.#idsByMessage.set(message, id);
    return { kind: "message", id, message: projectAgentMessage(message) };
  }
}

class MessageDecoder {
  readonly #messagesById = new Map<number, ProjectedAgentMessage>();

  decode(encoded: EncodedMessage): ProjectedAgentMessage {
    if (encoded.kind === "message") {
      this.#messagesById.set(encoded.id, encoded.message);
      return encoded.message;
    }

    const message = this.#messagesById.get(encoded.id);
    if (!message) {
      throw new Error(`PI_HARNESS_EVENT_PROTOCOL_UNKNOWN_MESSAGE_REFERENCE:${encoded.id}`);
    }
    return message;
  }
}

export type PiHarnessEncodedEvent = {
  readonly protocol: "pi-harness-event";
  readonly version: 2;
  readonly event: PiHarnessCompactEvent;
};

export type PiHarnessEncodedEventEmission = {
  readonly kind: "harness-event";
  readonly event: PiHarnessEncodedEvent;
};

export type PiHarnessEventStreamIdentity = {
  readonly stepKey: string;
  readonly executionId: string;
  readonly epoch: string;
};

const piHarnessEventStreamKey = ({
  stepKey,
  executionId,
  epoch,
}: PiHarnessEventStreamIdentity): string => `${stepKey}\u0000${executionId}\u0000${epoch}`;

function assertPiHarnessEncodedEvent(value: unknown): asserts value is PiHarnessEncodedEvent {
  assertPiHarnessJsonValue(value);
  if (
    typeof value !== "object" ||
    value === null ||
    !("protocol" in value) ||
    value.protocol !== "pi-harness-event" ||
    !("version" in value) ||
    value.version !== 2 ||
    !("event" in value) ||
    typeof value.event !== "object" ||
    value.event === null ||
    !("type" in value.event) ||
    typeof value.event.type !== "string"
  ) {
    throw new Error("PI_HARNESS_EVENT_PROTOCOL_UNSUPPORTED_PROTOCOL");
  }
}

export class PiHarnessEventEncoder {
  readonly #messages = new MessageEncoder();
  readonly #values = new ValueEncoder();
  #activeAssistantMessage: ProjectedAssistantMessage | undefined;

  encode(event: PiHarnessSubscribedEvent): PiHarnessEncodedEvent {
    return snapshotPiHarnessJsonValue(
      {
        protocol: "pi-harness-event",
        version: 2,
        event: this.#encodeEvent(event),
      },
      `$event.${event.type}`,
    );
  }

  #encodeEvent(event: PiHarnessSubscribedEvent): PiHarnessCompactEvent {
    switch (event.type) {
      case "agent_start":
      case "turn_start":
        return { type: event.type };
      case "agent_end":
        return {
          type: event.type,
          messages: event.messages.map((message) => this.#messages.encode(message)),
        };
      case "turn_end":
        return {
          type: event.type,
          message: this.#messages.encode(event.message),
          toolResults: event.toolResults.map((message) => this.#messages.encode(message)),
        };
      case "message_start":
        this.#activeAssistantMessage =
          event.message.role === "assistant"
            ? snapshotPiHarnessJsonValue(projectAssistantMessage(event.message))
            : undefined;
        return {
          type: event.type,
          message: this.#messages.encode(event.message),
        };
      case "message_update": {
        if (!this.#activeAssistantMessage) {
          throw new Error("PI_HARNESS_EVENT_PROTOCOL_MESSAGE_UPDATE_WITHOUT_ASSISTANT_START");
        }
        if (event.message.role !== "assistant") {
          throw new Error("PI_HARNESS_EVENT_PROTOCOL_MESSAGE_UPDATE_NOT_ASSISTANT");
        }

        const assistantMessageEvent = streamedMessageUpdateEvent(event.assistantMessageEvent);
        const update = compactAssistantMessageEvent(
          assistantMessageEvent,
          this.#activeAssistantMessage,
        );
        const metadata = compactAssistantMessageMetadataUpdate(
          this.#activeAssistantMessage,
          assistantMessageEvent.partial,
        );
        this.#activeAssistantMessage = snapshotPiHarnessJsonValue(
          projectAssistantMessage(assistantMessageEvent.partial),
        );

        return {
          type: event.type,
          update,
          ...(metadata ? { metadata } : {}),
        };
      }
      case "message_end":
        this.#activeAssistantMessage = undefined;
        return {
          type: event.type,
          message: this.#messages.encode(event.message),
        };
      case "tool_execution_start":
        return { ...event, args: this.#values.encode(event.args) };
      case "tool_execution_update":
        return {
          ...event,
          args: this.#values.encode(event.args),
          partialResult: this.#values.encode(
            snapshotPiHarnessJsonValue(
              event.partialResult,
              "$event.tool_execution_update.partialResult",
            ),
          ),
        };
      case "tool_execution_end":
        return { ...event, result: this.#values.encode(event.result) };
      case "queue_update":
        return {
          type: event.type,
          steer: event.steer.map((message) => this.#messages.encode(message)),
          followUp: event.followUp.map((message) => this.#messages.encode(message)),
          nextTurn: event.nextTurn.map((message) => this.#messages.encode(message)),
        };
      case "save_point":
      case "settled":
      case "retry_scheduled":
      case "retry_attempt_start":
      case "retry_finished":
      case "thinking_level_update":
      case "tools_update":
        return event;
      case "abort":
        return {
          type: event.type,
          clearedSteer: event.clearedSteer.map((message) => this.#messages.encode(message)),
          clearedFollowUp: event.clearedFollowUp.map((message) => this.#messages.encode(message)),
        };
      case "after_provider_response":
        return {
          type: event.type,
          status: event.status,
          headers: this.#values.encode(event.headers),
        };
      case "session_compact":
        return {
          type: event.type,
          compactionEntry: this.#values.encode(event.compactionEntry),
          fromHook: event.fromHook,
        };
      case "session_tree":
        return {
          type: event.type,
          newLeafId: event.newLeafId,
          oldLeafId: event.oldLeafId,
          ...(event.summaryEntry ? { summaryEntry: this.#values.encode(event.summaryEntry) } : {}),
          ...(event.fromHook === undefined ? {} : { fromHook: event.fromHook }),
        };
      case "model_update":
        return {
          type: event.type,
          model: this.#values.encode(event.model),
          ...(event.previousModel
            ? { previousModel: this.#values.encode(event.previousModel) }
            : {}),
          source: event.source,
        };
      case "resources_update":
        return {
          type: event.type,
          resources: this.#values.encode(event.resources),
          previousResources: this.#values.encode(event.previousResources),
        };
      default:
        return { type: "raw", event };
    }
  }
}

export const piHarnessEventProtocol = {
  createEncoder: () => new PiHarnessEventEncoder(),
  createDecoder: () => new PiHarnessEventDecoder(),
  eventType: (value) => {
    assertPiHarnessEncodedEvent(value);
    return value.event.type === "raw" ? value.event.event.type : value.event.type;
  },
} satisfies PiHarnessEventProtocol;

export class PiHarnessEventDecoder {
  readonly #messages = new MessageDecoder();
  readonly #values = new ValueDecoder();
  #activeAssistantMessage: ProjectedAssistantMessage | undefined;

  decode(value: unknown): PiHarnessFrontendEvent {
    const encoded = freezePiHarnessJsonValue(value);
    assertPiHarnessEncodedEvent(encoded);
    return this.#decodeEvent(encoded.event);
  }

  #decodeEvent(encoded: PiHarnessCompactEvent): PiHarnessFrontendEvent {
    switch (encoded.type) {
      case "raw":
        return encoded.event as PiHarnessFrontendEvent;
      case "agent_start":
      case "turn_start":
        return { type: encoded.type };
      case "agent_end":
        return {
          type: encoded.type,
          messages: encoded.messages.map((message) => this.#messages.decode(message)),
        };
      case "turn_end":
        return {
          type: encoded.type,
          message: this.#messages.decode(encoded.message),
          toolResults: encoded.toolResults.map((message) =>
            this.#messages.decode(message),
          ) as SubscribedEvent<"turn_end">["toolResults"],
        };
      case "message_start": {
        const message = this.#messages.decode(encoded.message);
        this.#activeAssistantMessage = message.role === "assistant" ? message : undefined;
        return { type: encoded.type, message };
      }
      case "message_update": {
        if (!this.#activeAssistantMessage) {
          throw new Error("PI_HARNESS_EVENT_PROTOCOL_MESSAGE_UPDATE_WITHOUT_ASSISTANT_START");
        }

        const reconstructedMessage = snapshotPiHarnessJsonValue(this.#activeAssistantMessage);
        applyCompactAssistantMessageEvent(reconstructedMessage, encoded.update);
        const message = encoded.metadata
          ? assistantMessageWithMetadataUpdate(reconstructedMessage, encoded.metadata)
          : reconstructedMessage;
        this.#activeAssistantMessage = message;

        return {
          type: encoded.type,
          message,
          assistantMessageEvent: streamedAssistantMessageEvent(encoded.update, message),
        };
      }
      case "message_end": {
        const message = this.#messages.decode(encoded.message);
        this.#activeAssistantMessage = undefined;
        return { type: encoded.type, message };
      }
      case "tool_execution_start":
        return { ...encoded, args: this.#values.decode(encoded.args) };
      case "tool_execution_update":
        return {
          ...encoded,
          args: this.#values.decode(encoded.args),
          partialResult: this.#values.decode(encoded.partialResult),
        };
      case "tool_execution_end":
        return { ...encoded, result: this.#values.decode(encoded.result) };
      case "queue_update":
        return {
          type: encoded.type,
          steer: encoded.steer.map((message) => this.#messages.decode(message)),
          followUp: encoded.followUp.map((message) => this.#messages.decode(message)),
          nextTurn: encoded.nextTurn.map((message) => this.#messages.decode(message)),
        };
      case "save_point":
      case "settled":
      case "retry_scheduled":
      case "retry_attempt_start":
      case "retry_finished":
      case "thinking_level_update":
        return encoded;
      case "tools_update":
        return {
          ...encoded,
          toolNames: [...encoded.toolNames],
          previousToolNames: [...encoded.previousToolNames],
          activeToolNames: [...encoded.activeToolNames],
          previousActiveToolNames: [...encoded.previousActiveToolNames],
        };
      case "abort":
        return {
          type: encoded.type,
          clearedSteer: encoded.clearedSteer.map((message) => this.#messages.decode(message)),
          clearedFollowUp: encoded.clearedFollowUp.map((message) => this.#messages.decode(message)),
        };
      case "after_provider_response":
        return {
          type: encoded.type,
          status: encoded.status,
          headers: this.#values.decode(encoded.headers),
        };
      case "session_compact":
        return {
          type: encoded.type,
          compactionEntry: this.#values.decode(encoded.compactionEntry),
          fromHook: encoded.fromHook,
        };
      case "session_tree":
        return {
          type: encoded.type,
          newLeafId: encoded.newLeafId,
          oldLeafId: encoded.oldLeafId,
          ...(encoded.summaryEntry
            ? {
                summaryEntry: this.#values.decode(encoded.summaryEntry),
              }
            : {}),
          ...(encoded.fromHook === undefined ? {} : { fromHook: encoded.fromHook }),
        };
      case "model_update":
        return {
          type: encoded.type,
          model: this.#values.decode(encoded.model),
          previousModel: encoded.previousModel
            ? this.#values.decode(encoded.previousModel)
            : undefined,
          source: encoded.source,
        };
      case "resources_update":
        return {
          type: encoded.type,
          resources: this.#values.decode(encoded.resources),
          previousResources: this.#values.decode(encoded.previousResources),
        };
    }

    throw new Error("PI_HARNESS_EVENT_PROTOCOL_UNKNOWN_EVENT");
  }
}

export class PiHarnessEventStreamDecoders {
  readonly #decodersByStream = new Map<string, PiHarnessEventDecoder>();

  start(identity: PiHarnessEventStreamIdentity): void {
    this.#decodersByStream.set(piHarnessEventStreamKey(identity), new PiHarnessEventDecoder());
  }

  finish(identity: PiHarnessEventStreamIdentity): void {
    this.#decodersByStream.delete(piHarnessEventStreamKey(identity));
  }

  decode(identity: PiHarnessEventStreamIdentity, event: unknown): PiHarnessFrontendEvent {
    const streamKey = piHarnessEventStreamKey(identity);
    const decoder = this.#decodersByStream.get(streamKey);
    if (!decoder) {
      throw new Error(`Pi harness event stream ${JSON.stringify(streamKey)} was not started.`);
    }
    return decoder.decode(event);
  }
}
