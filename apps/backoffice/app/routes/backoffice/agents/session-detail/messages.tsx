import {
  ChatActivity,
  ChatActivityNote,
  ChatActivityStep,
  type ChatActivityStatus,
} from "@fragno-private/design-system/chat-activity";
import { ChatEventDisclosure, ChatEventDivider } from "@fragno-private/design-system/chat-divider";
import {
  ChatAssistantMessage,
  ChatMessageActions,
  ChatStoppedNotice,
  ChatTokenUsage,
  ChatUserMessage,
} from "@fragno-private/design-system/chat-message";
import { CopyButton } from "@fragno-private/design-system/copy-button";
import { InlineAlert } from "@fragno-private/design-system/inline-alert";
import { WorkingIndicator } from "@fragno-private/design-system/working-indicator";

import { MessagePrimitive, useAuiState } from "@assistant-ui/react";

import { agentTurn, liveHeadline, type AgentTurnStep, type ToolCallPart } from "./agent-turn";
import {
  notificationRequestLabel,
  type PiAssistantMessageMetadata,
  type PiCompactionMessageMetadata,
  type PiNotificationMessageMetadata,
  type PiNotificationRequestMessageMetadata,
} from "./assistant-runtime";
import { MarkdownText, MessageImage } from "./message-content";
import {
  ToolCallStep,
  toolCallPresentation,
  toolHeadline,
  toolWorkspaceOptions,
  type ToolCallPresentation,
} from "./tool-call";
import { ToolWorkspaceSelector, type ToolWorkspaceSelectorOption } from "./tool-workspace-selector";
import { useSessionWorkspaceNavigation } from "./workspace-context";

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

/**
 * The agent's whole turn: one activity card for its thoughts and tool calls, then its answer.
 * The view options hide thoughts or tool calls from the card.
 */
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
  const parts = useAuiState((state) => state.message.parts);
  const running = useAuiState((state) => state.message.status?.type === "running");
  const navigation = useSessionWorkspaceNavigation();

  const { steps, answer } = agentTurn(parts, running);
  const tools = steps.flatMap((step): TurnTool[] => {
    if (step.kind !== "tool") {
      return [];
    }
    const presentation = toolCallPresentation(step.part);
    return [
      {
        part: step.part,
        presentation,
        workspaceOptions: toolWorkspaceOptions(step.part, presentation, navigation),
      },
    ];
  });
  const toolsById = new Map(tools.map((tool) => [tool.part.toolCallId, tool]));
  // The turn's result is what its newest tool call that made something produced.
  const artifactTool = tools.filter((tool) => tool.workspaceOptions.length > 0).at(-1) ?? null;
  const visibleSteps = steps.filter((step) =>
    step.kind === "thought" ? showThinking : step.kind === "tool" ? showToolCalls : true,
  );
  const answerText = answer
    .flatMap((part) => (part.kind === "text" ? [part.text] : []))
    .join("\n")
    .trim();
  const answering = running && answerText.length > 0;

  const stopped = metadata.stopReason === "aborted";
  const failure = stopped ? null : metadata.errorMessage;
  const usage = showUsage ? metadata.usage : null;
  const copyable = answerText.length > 0 && !running;
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
            cost={usage.cost}
          />
        )}
        {copyable ? (
          <ChatMessageActions>
            <CopyButton value={answerText} label="Copy response" />
          </ChatMessageActions>
        ) : null}
      </>
    ) : null;

  const thoughts = steps.filter((step) => step.kind === "thought").length;
  const status: ChatActivityStatus = running
    ? {
        kind: "running",
        headline: liveHeadline(steps, answering, (part) =>
          toolHeadline(toolCallPresentation(part)),
        ),
        startedAt: createdAt ?? new Date(),
      }
    : {
        kind: "settled",
        outcome: stopped ? "stopped" : failure !== null ? "failed" : "done",
        durationMs:
          metadata.finishedAt === null || createdAt === undefined
            ? null
            : metadata.finishedAt.getTime() - createdAt.getTime(),
        note: [count(tools.length, "tool"), count(thoughts, "thought")]
          .filter((part) => part !== null)
          .join(" · "),
        failedSteps: tools.filter((tool) => tool.presentation.failed).length,
      };

  return (
    <MessagePrimitive.Root asChild>
      <ChatAssistantMessage author={{ name: "Pi", time: createdAt ?? null }} footer={footer}>
        {visibleSteps.length > 0 ? (
          <ChatActivity
            status={status}
            artifacts={
              artifactTool === null ? null : (
                <ToolWorkspaceSelector
                  options={artifactTool.workspaceOptions}
                  toolLabel={artifactTool.presentation.label}
                  labelled
                />
              )
            }
          >
            {visibleSteps.map((step) => (
              <TurnStep key={step.key} step={step} tools={toolsById} />
            ))}
          </ChatActivity>
        ) : running && !answering ? (
          <WorkingIndicator>{metadata.statusText ?? "Working…"}</WorkingIndicator>
        ) : null}
        {answer.map((part) =>
          part.kind === "text" ? (
            <MarkdownText key={part.key} text={part.text} />
          ) : (
            <MessageImage key={part.key} image={part.image} />
          ),
        )}
      </ChatAssistantMessage>
    </MessagePrimitive.Root>
  );
}

function count(amount: number, noun: string) {
  return amount === 0 ? null : `${amount} ${noun}${amount === 1 ? "" : "s"}`;
}

type TurnTool = {
  part: ToolCallPart;
  presentation: ToolCallPresentation;
  workspaceOptions: ToolWorkspaceSelectorOption[];
};

function TurnStep({ step, tools }: { step: AgentTurnStep; tools: ReadonlyMap<string, TurnTool> }) {
  if (step.kind === "thought") {
    return (
      <ChatActivityStep
        icon={null}
        state={step.running ? "running" : "done"}
        title={step.headline}
        detail={null}
        durationMs={null}
        outlined={false}
        actions={null}
      >
        {step.text.length === 0 ? null : (
          <MarkdownText
            text={step.text}
            className="text-xs leading-6 text-[var(--bo-muted)] [&_h1]:text-sm [&_h2]:text-[13px] [&_h3]:text-xs [&_h4]:text-xs"
          />
        )}
      </ChatActivityStep>
    );
  }
  if (step.kind === "note") {
    return (
      <ChatActivityNote>
        <MarkdownText text={step.text} className="text-xs leading-5" />
      </ChatActivityNote>
    );
  }
  if (step.kind === "image") {
    return (
      <ChatActivityNote>
        <MessageImage image={step.image} />
      </ChatActivityNote>
    );
  }
  const tool = tools.get(step.part.toolCallId);
  return tool ? (
    <ToolCallStep
      part={tool.part}
      presentation={tool.presentation}
      workspaceOptions={tool.workspaceOptions}
    />
  ) : null;
}

const compactionReasonLabels: Record<PiCompactionMessageMetadata["reason"], string> = {
  manual: "Requested",
  threshold: "Automatic",
  overflow: "Context overflow",
};

/** Marks where the context was cleared; Pi sees nothing from before it. */
export function ResetMessage() {
  return (
    <MessagePrimitive.Root asChild>
      <ChatEventDivider marker="accent" time={null}>
        Context cleared
      </ChatEventDivider>
    </MessagePrimitive.Root>
  );
}

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
      <ChatEventDisclosure
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
      </ChatEventDisclosure>
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
      <ChatEventDisclosure
        marker="notification"
        title={`${notification.event.source} · ${notification.event.eventType}`}
        note={notification.routeId === null ? null : `via ${notification.routeId}`}
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
      </ChatEventDisclosure>
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
