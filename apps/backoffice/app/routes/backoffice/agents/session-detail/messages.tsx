import { parseBackofficeUiResult } from "@fragno-private/backoffice-ui/result";
import {
  ChatActivity,
  ChatActivityNote,
  ChatActivityStep,
  type ChatActivityStatus,
} from "@fragno-private/design-system/chat-activity";
import {
  ChatEventDisclosure,
  ChatEventDivider,
  ChatEventLink,
} from "@fragno-private/design-system/chat-divider";
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

import { workflowCompletionFromNotification } from "@/fragno/automation/workflow-reply";

import { agentTurn, liveHeadline, type AgentTurnStep, type ToolCallPart } from "./agent-turn";
import {
  notificationRequestLabel,
  type PiAssistantMessageMetadata,
  type PiCompactionMessageMetadata,
  type PiNotificationMessageMetadata,
  type PiNotificationRequestMessageMetadata,
} from "./assistant-runtime";
import { MarkdownText, MessageImage } from "./message-content";
import { ResultContent } from "./result-content";
import { SessionWorkflow, useSessionRun } from "./session-workflow";
import {
  ToolCallStep,
  toolCallPresentation,
  toolHeadline,
  toolWorkspaceOptions,
  type ToolCallPresentation,
} from "./tool-call";
import { ToolWorkspaceSelector, type ToolWorkspaceSelectorOption } from "./tool-workspace-selector";
import { turnTranscript } from "./turn-transcript";
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
 * The agent's whole turn: one activity card for its thoughts and tool calls, the workflows they
 * started, then its answer. The view options hide thoughts or tool calls from the card.
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
  const workflowRuns = tools.flatMap((tool) => tool.presentation.codemodeDetails?.run ?? []);
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
  // Without steps the full turn is just the response.
  const turnCopyable = steps.length > 0 && !running;
  const footer =
    stopped || failure !== null || usage !== null || copyable || turnCopyable ? (
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
        {copyable || turnCopyable ? (
          <ChatMessageActions>
            {copyable ? (
              <CopyButton value={answerText} label="Copy response" labelled={turnCopyable} />
            ) : null}
            {turnCopyable ? (
              <CopyButton
                value={() => turnTranscript({ steps, answer, stopped, failure })}
                label="Copy full turn"
                labelled
              />
            ) : null}
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

  const shown = visibleSteps.length > 0 || workflowRuns.length > 0 || answer.length > 0;
  const { notificationRequest } = metadata;
  // A turn can end without saying anything, such as one that acknowledged a finished workflow
  // whose card already shows the result; an author with nothing under it reads as a stuck reply.
  // A silent answer to notifications goes with its request, whatever copy or usage it offers,
  // unless it failed or was stopped.
  const silent =
    !running &&
    !shown &&
    (footer === null || (notificationRequest !== null && !stopped && failure === null));
  if (silent) {
    return null;
  }
  // A turn answering notifications is one line until it has something to show.
  const handling = notificationRequest !== null && running && !shown;
  const requestLine =
    notificationRequest === null ? null : (
      <ChatEventDivider marker={handling ? "progress" : "notification"} time={createdAt ?? null}>
        {handling ? (
          <span className="bo-shimmer-text">
            {notificationRequestLabel(notificationRequest, "handling")}
          </span>
        ) : (
          notificationRequestLabel(notificationRequest, "asked")
        )}
      </ChatEventDivider>
    );
  if (handling) {
    return <>{requestLine}</>;
  }

  return (
    <>
      {requestLine}
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
          {workflowRuns.map((run) => (
            <SessionWorkflow key={run.instanceId} run={run} />
          ))}
          {answer.map((part) =>
            part.kind === "text" ? (
              <MarkdownText key={part.key} text={part.text} />
            ) : (
              <MessageImage key={part.key} image={part.image} />
            ),
          )}
        </ChatAssistantMessage>
      </MessagePrimitive.Root>
    </>
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
        defaultOpen={false}
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

/**
 * An event a route delivered to the agent; expanding it shows the event's subject and payload. A
 * workflow's completion opens on its output when the output is an interface.
 */
export function NotificationMessage() {
  const createdAt = useAuiState((state) => state.message.createdAt);
  const { notification } = useAuiState(
    (state) => state.message.metadata.custom as PiNotificationMessageMetadata,
  );
  const data = useAuiState((state) =>
    state.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
  );
  const completion = workflowCompletionFromNotification(notification.event);
  const run = useSessionRun(completion?.instanceId ?? null);
  const completionUi = completion === null ? null : parseBackofficeUiResult(completion.output);
  const output =
    completion !== null && completionUi !== null && completionUi.kind !== "ordinary"
      ? { parsed: completionUi, value: completion.output }
      : null;
  const title = `${notification.event.source} · ${notification.event.eventType}`;

  // The run's card above holds its output, so the event leads back to it rather than repeat it.
  if (completion !== null && run !== null) {
    return (
      <MessagePrimitive.Root asChild>
        <ChatEventLink
          marker="live"
          title={title}
          note={completion.workflowName}
          time={createdAt ?? null}
          action={output === null ? "View run" : "View result"}
          onShow={run.show}
        />
      </MessagePrimitive.Root>
    );
  }

  return (
    <MessagePrimitive.Root asChild>
      <ChatEventDisclosure
        defaultOpen={output !== null}
        marker="notification"
        title={title}
        note={
          completion !== null
            ? completion.workflowName
            : notification.routeId === null
              ? null
              : `via ${notification.routeId}`
        }
        time={createdAt ?? null}
      >
        {output !== null ? (
          <ResultContent parsedValue={output.parsed} showRawValue={false} value={output.value}>
            {null}
          </ResultContent>
        ) : (
          <>
            <p className="mb-2 text-[10px] text-[var(--bo-muted-2)]">
              Event {notification.event.id},{" "}
              {notification.routeId === null
                ? "addressed to this agent."
                : "delivered by an automation route."}
            </p>
            <pre className="overflow-x-auto text-xs leading-5 whitespace-pre-wrap text-[var(--bo-muted)]">
              {data}
            </pre>
          </>
        )}
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
        {notificationRequestLabel(notifications, "asked")}
      </ChatEventDivider>
    </MessagePrimitive.Root>
  );
}
