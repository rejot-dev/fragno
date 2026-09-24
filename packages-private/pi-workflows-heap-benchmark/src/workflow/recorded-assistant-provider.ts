import {
  createProvider,
  lazyStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type Provider,
  type ProviderStreams,
  type StopReason,
  type TextContent,
  type ThinkingContent,
} from "@earendil-works/pi-ai";

const recordedProviderId = "recorded-assistant";
const recordedModelId = "recorded-poem-trace";

export type RecordedAssistantTrace = {
  schemaVersion: 1;
  capturedAt: string;
  prompt: string;
  sourceModel: Model<Api>;
  events: RecordedAssistantTraceEvent[];
};

type AssistantMessageMetadata = Omit<AssistantMessage, "content">;

type RecordedAssistantTraceEvent =
  | { afterMs: number; type: "start"; message: AssistantMessage }
  | {
      afterMs: number;
      type: "text_start";
      contentIndex: number;
      block: TextContent;
      message: AssistantMessageMetadata;
    }
  | {
      afterMs: number;
      type: "text_delta";
      contentIndex: number;
      delta: string;
      message: AssistantMessageMetadata;
    }
  | {
      afterMs: number;
      type: "text_end";
      contentIndex: number;
      block: TextContent;
      message: AssistantMessageMetadata;
    }
  | {
      afterMs: number;
      type: "thinking_start";
      contentIndex: number;
      block: ThinkingContent;
      message: AssistantMessageMetadata;
    }
  | {
      afterMs: number;
      type: "thinking_delta";
      contentIndex: number;
      delta: string;
      message: AssistantMessageMetadata;
    }
  | {
      afterMs: number;
      type: "thinking_end";
      contentIndex: number;
      block: ThinkingContent;
      message: AssistantMessageMetadata;
    }
  | {
      afterMs: number;
      type: "done";
      reason: Extract<StopReason, "stop" | "length" | "toolUse">;
      message: AssistantMessage;
    }
  | {
      afterMs: number;
      type: "error";
      reason: Extract<StopReason, "aborted" | "error">;
      message: AssistantMessage;
    };

type CaptureAssistantTraceOptions = {
  prompt: string;
  writeTrace: (trace: RecordedAssistantTrace) => Promise<void>;
};

type RecordedAssistantProvider = {
  provider: Provider;
  model: Model<Api>;
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function recordedAssistantReplayAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Recorded assistant replay aborted.");
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(recordedAssistantReplayAbortError(signal));
  }
  if (ms <= 0) {
    return Promise.resolve();
  }
  if (!signal) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
  return new Promise((resolve, reject) => {
    const handleTimer = () => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    };
    const handleAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", handleAbort);
      reject(recordedAssistantReplayAbortError(signal));
    };
    const timeout = setTimeout(handleTimer, ms);
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

function messageMetadata(message: AssistantMessage): AssistantMessageMetadata {
  const { content: _content, ...metadata } = message;
  return clone(metadata);
}

function contentBlockAt(
  event: Extract<
    AssistantMessageEvent,
    { type: "text_start" | "text_end" | "thinking_start" | "thinking_end" }
  >,
): TextContent | ThinkingContent {
  const block = event.partial.content[event.contentIndex];
  if ((event.type === "text_start" || event.type === "text_end") && block?.type === "text") {
    return clone(block);
  }
  if (
    (event.type === "thinking_start" || event.type === "thinking_end") &&
    block?.type === "thinking"
  ) {
    return clone(block);
  }
  throw new Error(`Recorded assistant trace has no ${event.type} block at ${event.contentIndex}.`);
}

function recordEvent(event: AssistantMessageEvent, afterMs: number): RecordedAssistantTraceEvent {
  switch (event.type) {
    case "start":
      return { afterMs, type: "start", message: clone(event.partial) };
    case "text_start":
      return {
        afterMs,
        type: event.type,
        contentIndex: event.contentIndex,
        block: contentBlockAt(event) as TextContent,
        message: messageMetadata(event.partial),
      };
    case "text_delta":
      return {
        afterMs,
        type: event.type,
        contentIndex: event.contentIndex,
        delta: event.delta,
        message: messageMetadata(event.partial),
      };
    case "text_end":
      return {
        afterMs,
        type: event.type,
        contentIndex: event.contentIndex,
        block: contentBlockAt(event) as TextContent,
        message: messageMetadata(event.partial),
      };
    case "thinking_start":
      return {
        afterMs,
        type: event.type,
        contentIndex: event.contentIndex,
        block: contentBlockAt(event) as ThinkingContent,
        message: messageMetadata(event.partial),
      };
    case "thinking_delta":
      return {
        afterMs,
        type: event.type,
        contentIndex: event.contentIndex,
        delta: event.delta,
        message: messageMetadata(event.partial),
      };
    case "thinking_end":
      return {
        afterMs,
        type: event.type,
        contentIndex: event.contentIndex,
        block: contentBlockAt(event) as ThinkingContent,
        message: messageMetadata(event.partial),
      };
    case "done":
      return {
        afterMs,
        type: event.type,
        reason: event.reason,
        message: clone(event.message),
      };
    case "error":
      return {
        afterMs,
        type: event.type,
        reason: event.reason,
        message: clone(event.error),
      };
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
      throw new Error("The poem benchmark trace cannot contain tool calls.");
  }
  throw new Error("The poem benchmark trace contains an unsupported event.");
}

async function* captureAssistantTrace(
  source: AsyncIterable<AssistantMessageEvent>,
  sourceModel: Model<Api>,
  options: CaptureAssistantTraceOptions,
): AsyncGenerator<AssistantMessageEvent> {
  const events: RecordedAssistantTraceEvent[] = [];
  let previousEventAt = performance.now();
  let terminalSeen = false;
  for await (const event of source) {
    const eventAt = performance.now();
    events.push(recordEvent(event, eventAt - previousEventAt));
    previousEventAt = eventAt;
    if (event.type === "done" || event.type === "error") {
      terminalSeen = true;
      await options.writeTrace({
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        prompt: options.prompt,
        sourceModel: clone(sourceModel),
        events,
      });
    }
    yield event;
  }
  if (!terminalSeen) {
    throw new Error("Assistant provider stream ended without a terminal event.");
  }
}

/** Wrap a real provider and persist the compact event trace from its completed response. */
export function createAssistantTraceCaptureProvider(
  sourceProvider: Provider,
  options: CaptureAssistantTraceOptions,
): Provider {
  function capture(model: Model<Api>, source: AsyncIterable<AssistantMessageEvent>) {
    return lazyStream(model, async () => captureAssistantTrace(source, model, options));
  }

  const api: ProviderStreams = {
    stream: (model, context, streamOptions) =>
      capture(model, sourceProvider.stream(model, context, streamOptions)),
    streamSimple: (model, context, streamOptions) =>
      capture(model, sourceProvider.streamSimple(model, context, streamOptions)),
  };
  return createProvider({
    id: sourceProvider.id,
    name: sourceProvider.name,
    baseUrl: sourceProvider.baseUrl,
    headers: sourceProvider.headers,
    auth: sourceProvider.auth,
    models: sourceProvider.getModels(),
    api,
  });
}

function assistantMessage(
  metadata: AssistantMessageMetadata,
  content: AssistantMessage["content"],
): AssistantMessage {
  return { ...clone(metadata), content: clone(content) };
}

async function* replayAssistantTrace(
  trace: RecordedAssistantTrace,
  replaySpeed: number,
  signal: AbortSignal | undefined,
): AsyncGenerator<AssistantMessageEvent> {
  let content: AssistantMessage["content"] = [];
  const replayStartedAt = performance.now();
  let scheduledElapsedMs = 0;
  for (const event of trace.events) {
    scheduledElapsedMs += event.afterMs / replaySpeed;
    await sleep(Math.max(0, replayStartedAt + scheduledElapsedMs - performance.now()), signal);
    switch (event.type) {
      case "start":
        content = clone(event.message.content);
        yield { type: "start", partial: clone(event.message) };
        break;
      case "text_start":
        content[event.contentIndex] = clone(event.block);
        yield {
          type: event.type,
          contentIndex: event.contentIndex,
          partial: assistantMessage(event.message, content),
        };
        break;
      case "text_delta": {
        const block = content[event.contentIndex];
        if (block?.type !== "text") {
          throw new Error(`Recorded text delta has no text block at ${event.contentIndex}.`);
        }
        block.text += event.delta;
        yield {
          type: event.type,
          contentIndex: event.contentIndex,
          delta: event.delta,
          partial: assistantMessage(event.message, content),
        };
        break;
      }
      case "text_end":
        content[event.contentIndex] = clone(event.block);
        yield {
          type: event.type,
          contentIndex: event.contentIndex,
          content: event.block.text,
          partial: assistantMessage(event.message, content),
        };
        break;
      case "thinking_start":
        content[event.contentIndex] = clone(event.block);
        yield {
          type: event.type,
          contentIndex: event.contentIndex,
          partial: assistantMessage(event.message, content),
        };
        break;
      case "thinking_delta": {
        const block = content[event.contentIndex];
        if (block?.type !== "thinking") {
          throw new Error(
            `Recorded thinking delta has no thinking block at ${event.contentIndex}.`,
          );
        }
        block.thinking += event.delta;
        yield {
          type: event.type,
          contentIndex: event.contentIndex,
          delta: event.delta,
          partial: assistantMessage(event.message, content),
        };
        break;
      }
      case "thinking_end":
        content[event.contentIndex] = clone(event.block);
        yield {
          type: event.type,
          contentIndex: event.contentIndex,
          content: event.block.thinking,
          partial: assistantMessage(event.message, content),
        };
        break;
      case "done":
        yield { type: event.type, reason: event.reason, message: clone(event.message) };
        break;
      case "error":
        yield { type: event.type, reason: event.reason, error: clone(event.message) };
        break;
    }
  }
}

/** Build a keyless Pi provider that replays one captured assistant response. */
export function createRecordedAssistantProvider(
  trace: RecordedAssistantTrace,
  replaySpeed: number,
): RecordedAssistantProvider {
  if (!Number.isFinite(replaySpeed) || replaySpeed <= 0) {
    throw new Error("Recorded assistant replay speed must be greater than zero.");
  }
  const model: Model<Api> = {
    ...clone(trace.sourceModel),
    id: recordedModelId,
    name: `Recorded ${trace.sourceModel.provider}/${trace.sourceModel.id}`,
    provider: recordedProviderId,
    baseUrl: "recorded://assistant-trace",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const api: ProviderStreams = {
    stream: (requestModel, _context, options) =>
      lazyStream(requestModel, async () =>
        replayAssistantTrace(trace, replaySpeed, options?.signal),
      ),
    streamSimple: (requestModel, _context, options) =>
      lazyStream(requestModel, async () =>
        replayAssistantTrace(trace, replaySpeed, options?.signal),
      ),
  };
  return {
    model,
    provider: createProvider({
      id: recordedProviderId,
      name: "Recorded assistant trace",
      auth: {
        apiKey: {
          name: "Recorded assistant trace",
          resolve: async () => ({ auth: {}, source: "Recorded assistant trace" }),
        },
      },
      models: [model],
      api,
    }),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isContentBlock(value: unknown): boolean {
  if (!isObject(value) || typeof value["type"] !== "string") {
    return false;
  }
  if (value["type"] === "text") {
    return typeof value["text"] === "string";
  }
  if (value["type"] === "thinking") {
    return typeof value["thinking"] === "string";
  }
  if (value["type"] === "toolCall") {
    return (
      typeof value["id"] === "string" &&
      typeof value["name"] === "string" &&
      isObject(value["arguments"])
    );
  }
  return false;
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  return (
    isObject(value) &&
    value["role"] === "assistant" &&
    Array.isArray(value["content"]) &&
    value["content"].every(isContentBlock) &&
    typeof value["api"] === "string" &&
    typeof value["provider"] === "string" &&
    typeof value["model"] === "string" &&
    isObject(value["usage"]) &&
    typeof value["stopReason"] === "string" &&
    isNonNegativeNumber(value["timestamp"])
  );
}

function isMessageMetadata(value: unknown): value is AssistantMessageMetadata {
  return isObject(value) && !("content" in value) && isAssistantMessage({ ...value, content: [] });
}

function isModel(value: unknown): value is Model<Api> {
  return (
    isObject(value) &&
    typeof value["id"] === "string" &&
    typeof value["name"] === "string" &&
    typeof value["api"] === "string" &&
    typeof value["provider"] === "string" &&
    typeof value["baseUrl"] === "string" &&
    typeof value["reasoning"] === "boolean" &&
    Array.isArray(value["input"]) &&
    isObject(value["cost"]) &&
    isNonNegativeNumber(value["contextWindow"]) &&
    isNonNegativeNumber(value["maxTokens"])
  );
}

function isRecordedEvent(value: unknown): value is RecordedAssistantTraceEvent {
  if (!isObject(value) || !isNonNegativeNumber(value["afterMs"])) {
    return false;
  }
  switch (value["type"]) {
    case "start":
      return isAssistantMessage(value["message"]);
    case "text_start":
    case "text_end":
      return (
        Number.isSafeInteger(value["contentIndex"]) &&
        isObject(value["block"]) &&
        value["block"]["type"] === "text" &&
        typeof value["block"]["text"] === "string" &&
        isMessageMetadata(value["message"])
      );
    case "text_delta":
    case "thinking_delta":
      return (
        Number.isSafeInteger(value["contentIndex"]) &&
        typeof value["delta"] === "string" &&
        isMessageMetadata(value["message"])
      );
    case "thinking_start":
    case "thinking_end":
      return (
        Number.isSafeInteger(value["contentIndex"]) &&
        isObject(value["block"]) &&
        value["block"]["type"] === "thinking" &&
        typeof value["block"]["thinking"] === "string" &&
        isMessageMetadata(value["message"])
      );
    case "done":
      return (
        (value["reason"] === "stop" ||
          value["reason"] === "length" ||
          value["reason"] === "toolUse") &&
        isAssistantMessage(value["message"])
      );
    case "error":
      return (
        (value["reason"] === "error" || value["reason"] === "aborted") &&
        isAssistantMessage(value["message"])
      );
    default:
      return false;
  }
}

/** Validate a recorded trace before giving its events to the trusted agent loop. */
export function parseRecordedAssistantTrace(input: unknown): RecordedAssistantTrace {
  if (
    !isObject(input) ||
    input["schemaVersion"] !== 1 ||
    typeof input["capturedAt"] !== "string" ||
    typeof input["prompt"] !== "string" ||
    !isModel(input["sourceModel"]) ||
    !Array.isArray(input["events"]) ||
    input["events"].length < 2 ||
    !input["events"].every(isRecordedEvent) ||
    input["events"][0]?.type !== "start" ||
    (input["events"].at(-1)?.type !== "done" && input["events"].at(-1)?.type !== "error")
  ) {
    throw new Error("Recorded assistant trace is invalid.");
  }
  return input as RecordedAssistantTrace;
}
