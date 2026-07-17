import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai";

type PiAssistantEvent<TType extends AssistantMessageEvent["type"]> = Extract<
  AssistantMessageEvent,
  { type: TType }
>;

/**
 * Compact shadow protocol for Pi's `message_update` events.
 *
 * Pi emits a full `message` plus an assistant sub-event whose `partial` field grows with every
 * token. The harness only needs the sub-event delta to update live projection state, so this
 * protocol intentionally strips the full message and every `partial` snapshot.
 */
export type PiHarnessMessageUpdate = {
  type: "message_update";
  assistantMessageEvent: PiHarnessAssistantMessageEvent;
};

export type PiHarnessAssistantMessageEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number; toolCall?: ToolCall }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; toolCall?: ToolCall }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
  | { type: "done"; reason: PiAssistantEvent<"done">["reason"] }
  | { type: "error"; reason: PiAssistantEvent<"error">["reason"]; errorMessage?: string };

export type PiHarnessMessageUpdateEmission = {
  kind: "harness-message-update";
  update: PiHarnessMessageUpdate;
};

export const piHarnessMessageUpdateFromPiEvent = (
  event: Extract<AgentHarnessEvent, { type: "message_update" }>,
): PiHarnessMessageUpdate => ({
  type: "message_update",
  assistantMessageEvent: piHarnessAssistantMessageEventFromPiEvent(event.assistantMessageEvent),
});

const piHarnessAssistantMessageEventFromPiEvent = (
  event: AssistantMessageEvent,
): PiHarnessAssistantMessageEvent => {
  switch (event.type) {
    case "start":
      return { type: "start" };
    case "text_start":
      return { type: "text_start", contentIndex: event.contentIndex };
    case "text_delta":
      return { type: "text_delta", contentIndex: event.contentIndex, delta: event.delta };
    case "text_end":
      return { type: "text_end", contentIndex: event.contentIndex, content: event.content };
    case "thinking_start":
      return { type: "thinking_start", contentIndex: event.contentIndex };
    case "thinking_delta":
      return { type: "thinking_delta", contentIndex: event.contentIndex, delta: event.delta };
    case "thinking_end":
      return {
        type: "thinking_end",
        contentIndex: event.contentIndex,
        content: event.content,
      };
    case "toolcall_start":
      return {
        type: "toolcall_start",
        contentIndex: event.contentIndex,
        toolCall: toolCallFromPartial(event),
      };
    case "toolcall_delta":
      return {
        type: "toolcall_delta",
        contentIndex: event.contentIndex,
        delta: event.delta,
        toolCall: toolCallFromPartial(event),
      };
    case "toolcall_end":
      return { type: "toolcall_end", contentIndex: event.contentIndex, toolCall: event.toolCall };
    case "done":
      return { type: "done", reason: event.reason };
    case "error":
      return { type: "error", reason: event.reason, errorMessage: event.error.errorMessage };
  }

  throw new Error("Unsupported assistant message event type.");
};

const toolCallFromPartial = (
  event: PiAssistantEvent<"toolcall_start" | "toolcall_delta">,
): ToolCall | undefined => {
  const content = event.partial.content[event.contentIndex];
  return content?.type === "toolCall" ? content : undefined;
};
