import { ActivityDisclosure } from "@fragno-private/design-system/activity-disclosure";
import { ChatEventDivider } from "@fragno-private/design-system/chat-divider";
import {
  ChatAssistantMessage,
  ChatEventMessage,
  ChatMessageActions,
  ChatReasoningTrace,
  ChatStoppedNotice,
  ChatTokenUsage,
  ChatUserMessage,
} from "@fragno-private/design-system/chat-message";
import { CopyButton } from "@fragno-private/design-system/copy-button";
import { InlineAlert } from "@fragno-private/design-system/inline-alert";
import { WorkingIndicator } from "@fragno-private/design-system/working-indicator";
import type { ReactNode } from "react";

import { MessagePrimitive, groupPartByType, useAuiState } from "@assistant-ui/react";

import {
  notificationRequestLabel,
  type PiAssistantMessageMetadata,
  type PiCompactionMessageMetadata,
  type PiNotificationMessageMetadata,
  type PiNotificationRequestMessageMetadata,
} from "./assistant-runtime";
import { MarkdownText, MessageImage } from "./message-content";
import { ToolCallBlock } from "./tool-call";

const reasoningGrouping = groupPartByType({
  reasoning: ["group-reasoning"],
});

export function UserMessage() {
  const createdAt = useAuiState((state) => state.message.createdAt);

  return (
    <MessagePrimitive.Root asChild>
      <ChatUserMessage time={createdAt ?? null}>
        <MessagePrimitive.Parts components={{ Text: MarkdownText, Image: MessageImage }} />
      </ChatUserMessage>
    </MessagePrimitive.Root>
  );
}

export function AssistantMessage({
  showThinking,
  showToolCalls,
  showUsage,
}: {
  showThinking: boolean;
  showToolCalls: boolean;
  showUsage: boolean;
}) {
  const createdAt = useAuiState((state) => state.message.createdAt);
  const metadata = useAuiState(
    (state) => state.message.metadata.custom as PiAssistantMessageMetadata,
  );
  const outputText = useAuiState((state) =>
    state.message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim(),
  );
  const hasToolCalls = useAuiState((state) =>
    state.message.content.some((part) => part.type === "tool-call"),
  );
  const isRunning = useAuiState((state) => state.message.status?.type === "running");
  const isFinalOutput = outputText.length > 0 && !hasToolCalls;
  const isToolCallOnly = hasToolCalls && outputText.length === 0;
  const stopped = metadata.stopReason === "aborted";
  const failure = stopped ? null : (metadata.errorMessage ?? null);
  const usage = showUsage ? (metadata.usage ?? null) : null;
  const copyable = isFinalOutput && !isRunning;
  const footer =
    stopped || failure !== null || usage !== null || copyable ? (
      <>
        {stopped ? <ChatStoppedNotice /> : null}
        {failure === null ? null : <InlineAlert>{failure}</InlineAlert>}
        {usage === null ? null : (
          <ChatTokenUsage
            input={usage.input}
            output={usage.output}
            total={usage.totalTokens}
            cost={usage.cost.total}
          />
        )}
        {copyable ? (
          <ChatMessageActions>
            <CopyButton value={outputText} label="Copy response" />
          </ChatMessageActions>
        ) : null}
      </>
    ) : null;

  return (
    <MessagePrimitive.Root asChild>
      <ChatAssistantMessage
        spacing={isToolCallOnly ? "tight" : "normal"}
        author={isFinalOutput ? { name: "Pi", time: createdAt ?? null } : null}
        footer={footer}
      >
        <MessagePrimitive.GroupedParts groupBy={reasoningGrouping} indicator="no-text">
          {({ part, children }) => {
            switch (part.type) {
              case "group-reasoning":
                return showThinking ? (
                  <ReasoningBlock createdAt={createdAt} status={part.status.type}>
                    {children}
                  </ReasoningBlock>
                ) : null;
              case "reasoning":
                return showThinking ? <ReasoningText text={part.text} /> : null;
              case "tool-call":
                return showToolCalls ? <ToolCallBlock {...part} /> : null;
              case "text":
                return <MarkdownText text={part.text} />;
              case "image":
                return <MessageImage image={part.image} />;
              case "indicator":
                return <WorkingIndicator>{metadata.statusText ?? "Working…"}</WorkingIndicator>;
              case "audio":
              case "data":
              case "file":
              case "generative-ui":
              case "source":
                return null;
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
      </ChatAssistantMessage>
    </MessagePrimitive.Root>
  );
}

const compactionReasonLabels: Record<PiCompactionMessageMetadata["reason"], string> = {
  manual: "Requested",
  threshold: "Automatic",
  overflow: "Context overflow",
};

/** Marks where Pi replaced earlier history with a summary; expanding it shows the summary. */
export function CompactionMessage() {
  const createdAt = useAuiState((state) => state.message.createdAt);
  const metadata = useAuiState(
    (state) => state.message.metadata.custom as PiCompactionMessageMetadata,
  );
  const summary = useAuiState((state) =>
    state.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
  );

  return (
    <MessagePrimitive.Root asChild>
      <ChatEventMessage>
        <ActivityDisclosure
          marker="accent"
          title="Context compacted"
          note={compactionReasonLabels[metadata.reason]}
          time={createdAt ?? null}
        >
          <div className="text-sm leading-7 text-[var(--bo-muted)]">
            <p className="mb-2 text-[10px] text-[var(--bo-muted-2)]">
              Pi continues from this summary instead of the history before it.
            </p>
            <MarkdownText text={summary} className="[&_h2]:text-sm [&_h3]:text-xs" />
          </div>
        </ActivityDisclosure>
      </ChatEventMessage>
    </MessagePrimitive.Root>
  );
}

/** An event a route delivered to the agent; expanding it shows the event's subject and payload. */
export function NotificationMessage() {
  const createdAt = useAuiState((state) => state.message.createdAt);
  const { notification } = useAuiState(
    (state) => state.message.metadata.custom as PiNotificationMessageMetadata,
  );
  const data = useAuiState((state) =>
    state.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
  );

  return (
    <MessagePrimitive.Root asChild>
      <ChatEventMessage>
        <ActivityDisclosure
          marker="notification"
          title={`${notification.event.source} · ${notification.event.eventType}`}
          note={notification.routeId === null ? undefined : `via ${notification.routeId}`}
          time={createdAt ?? null}
        >
          <p className="mb-2 text-[10px] text-[var(--bo-muted-2)]">
            Event {notification.event.id},{" "}
            {notification.routeId === null
              ? "addressed to this agent."
              : "delivered by an automation route."}
          </p>
          <pre className="overflow-x-auto text-xs leading-5 whitespace-pre-wrap text-[var(--bo-muted)]">
            {data}
          </pre>
        </ActivityDisclosure>
      </ChatEventMessage>
    </MessagePrimitive.Root>
  );
}

/** Where the agent was asked to handle the listed notifications, whose cards are above. */
export function NotificationRequestMessage() {
  const createdAt = useAuiState((state) => state.message.createdAt);
  const { notifications } = useAuiState(
    (state) => state.message.metadata.custom as PiNotificationRequestMessageMetadata,
  );

  return (
    <MessagePrimitive.Root asChild>
      <ChatEventDivider
        marker="notification"
        time={createdAt ?? null}
        title={notifications
          .map(({ routeId, eventId }) => (routeId === null ? eventId : `${eventId} via ${routeId}`))
          .join("\n")}
      >
        {notificationRequestLabel(notifications)}
      </ChatEventDivider>
    </MessagePrimitive.Root>
  );
}

function ReasoningBlock({
  children,
  createdAt,
  status,
}: {
  children: ReactNode;
  createdAt?: Date;
  status: string;
}) {
  const running = status === "running";
  return (
    <ActivityDisclosure
      marker={running ? "progress" : null}
      title={running ? "Working" : "Reasoning"}
      time={createdAt ?? null}
      autoOpen={running}
    >
      {children}
    </ActivityDisclosure>
  );
}

function ReasoningText({ text }: { text: string }) {
  return (
    <ChatReasoningTrace>
      <MarkdownText
        text={text}
        className="text-xs leading-6 [&_h1]:text-sm [&_h2]:text-[13px] [&_h3]:text-xs [&_h4]:text-xs"
      />
    </ChatReasoningTrace>
  );
}
