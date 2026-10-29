import { backofficeContextScopesEqual } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { parseBackofficeUiResult } from "@fragno-private/backoffice-ui/result";
import {
  ChatActivity,
  ChatActivityStep,
  type ChatActivityStatus,
} from "@fragno-private/design-system/chat-activity";
import { ChatMessageAttachments } from "@fragno-private/design-system/chat-attachment";
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
import { Fragment } from "react";

import { MessagePrimitive, useAuiState } from "@assistant-ui/react";

import { backofficeRuntimeScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { useCurrentBackofficeContext } from "@/components/backoffice/current-context";
import { FileScopeProvider, useFileScope } from "@/components/backoffice/file-scope";
import { workflowCompletionFromNotification } from "@/fragno/automation/workflow-reply";
import type { PiAgentNotification } from "@/fragno/pi/agent/pi-agent-contract";
import type { PiNotificationReference } from "@/fragno/pi/agent/pi-agent-notification-entry";
import type { WorkflowRunReference } from "@/routes/backoffice/automations/script-view/workflow-run-presentation";

import { sentAttachmentItems } from "../agent-attachments";
import {
  ToolCallSubagents,
  useSubagentReports,
  type SubagentReport,
} from "../agent-subagent-batches";
import { agentTurn, liveHeadline, type AgentTurnStep, type ToolCallPart } from "./agent-turn";
import {
  notificationRequestLabel,
  type PiAssistantMessageMetadata,
  type PiCompactionMessageMetadata,
  type PiNotificationsMessageMetadata,
  type PiUserMessageMetadata,
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
  const { attachments } = useAuiState(
    (state) => state.message.metadata.custom as PiUserMessageMetadata,
  );
  // A message of only files has no text to show.
  const written = useAuiState((state) => state.message.parts.length > 0);
  const scope = useFileScope();

  return (
    <MessagePrimitive.Root asChild>
      <ChatUserMessage
        time={createdAt ?? null}
        attachments={
          scope === null || attachments.length === 0 ? null : (
            <ChatMessageAttachments attachments={sentAttachmentItems(scope, attachments)} />
          )
        }
      >
        {written ? (
          <MessagePrimitive.Parts components={{ Text: MarkdownText, Image: MessageImage }} />
        ) : null}
      </ChatUserMessage>
    </MessagePrimitive.Root>
  );
}

/**
 * The agent's whole turn, in the order it happened: an activity card for each stretch of thoughts
 * and tool calls, followed by the workflows they started, and what the agent said between them.
 * The view options hide thoughts or tool calls from the cards.
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

  const segments = agentTurn(parts, running);
  const turn = segments.map((segment) =>
    segment.kind === "work" ? { ...segment, tools: turnTools(segment.steps, navigation) } : segment,
  );
  const tools = turn.flatMap((segment) => (segment.kind === "work" ? segment.tools : []));
  const works = segments.filter((segment) => segment.kind === "work").length;
  const lastWorkKey = segments.filter((segment) => segment.kind === "work").at(-1)?.key;
  const toolsById = new Map(tools.map((tool) => [tool.part.toolCallId, tool]));
  const lastShowing = runsLastShowing(tools);
  // The turn's result is what its newest tool call that made something produced.
  const artifactTool = tools.filter((tool) => tool.workspaceOptions.length > 0).at(-1) ?? null;
  const lastSegment = segments.at(-1);
  const answer = lastSegment?.kind === "said" ? lastSegment.parts : [];
  const answerText = answer
    .flatMap((part) => (part.kind === "text" ? [part.text] : []))
    .join("\n")
    .trim();

  const stopped = metadata.stopReason === "aborted";
  const failure = stopped ? null : metadata.errorMessage;
  const usage = showUsage ? metadata.usage : null;
  const copyable = answerText.length > 0 && !running;
  // Without work the full turn is just the response.
  const turnCopyable = works > 0 && !running;
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
              <CopyButton
                value={answerText}
                label="Copy response"
                text={turnCopyable ? "Copy response" : null}
              />
            ) : null}
            {turnCopyable ? (
              <CopyButton
                value={() => turnTranscript({ segments, stopped, failure })}
                label="Copy full turn"
                text="Copy full turn"
              />
            ) : null}
          </ChatMessageActions>
        ) : null}
      </>
    ) : null;

  const shownTurn = turn.map((segment) => {
    if (segment.kind === "said") {
      return segment;
    }
    const callIds = new Set(segment.tools.map((tool) => tool.part.toolCallId));
    // Work the agent has moved on from, by speaking or ending its turn, is done; only the turn's
    // last work stopped or failed with it. Only work that spans the whole turn was timed.
    const status: ChatActivityStatus =
      running && segment.key === lastSegment?.key
        ? {
            kind: "running",
            headline: liveHeadline(segment.steps, (part) =>
              toolHeadline(toolCallPresentation(part)),
            ),
            startedAt: createdAt ?? new Date(),
          }
        : {
            kind: "settled",
            outcome:
              running || segment.key !== lastWorkKey
                ? "done"
                : stopped
                  ? "stopped"
                  : failure !== null
                    ? "failed"
                    : "done",
            durationMs:
              running || works > 1 || metadata.finishedAt === null || createdAt === undefined
                ? null
                : metadata.finishedAt.getTime() - createdAt.getTime(),
            note: [
              count(segment.tools.length, "tool"),
              count(segment.steps.filter((step) => step.kind === "thought").length, "thought"),
            ]
              .filter((part) => part !== null)
              .join(" · "),
            failedSteps: segment.tools.filter((tool) => tool.presentation.failed).length,
          };
    return {
      ...segment,
      status,
      visibleSteps: segment.steps.filter((step) =>
        step.kind === "thought" ? showThinking : showToolCalls,
      ),
      artifactTool:
        artifactTool !== null && callIds.has(artifactTool.part.toolCallId) ? artifactTool : null,
      // A run shown more than once in a turn is one card, after the work that showed it last.
      workflowRuns: lastShownRuns(
        segment.tools.flatMap((tool) => tool.presentation.codemodeDetails?.runs ?? []),
      ).filter((run) => callIds.has(lastShowing.get(run.instanceId) ?? "")),
    };
  });
  const lastShown = shownTurn.at(-1);
  // What the agent says shows it at work, as does a card it works in.
  const working =
    running &&
    (lastShown === undefined || (lastShown.kind === "work" && lastShown.visibleSteps.length === 0));
  const shown = shownTurn.some(
    (segment) =>
      segment.kind === "said" || segment.visibleSteps.length > 0 || segment.workflowRuns.length > 0,
  );
  const { notificationRequest, notifications } = metadata;
  // A turn can end without saying anything, such as one that acknowledged a finished workflow
  // whose card already shows the result; an author with nothing under it reads as a stuck reply.
  // A silent answer to notifications goes with its request, whatever copy or usage it offers,
  // unless it failed or was stopped.
  const silent =
    !running &&
    !shown &&
    (footer === null || (notificationRequest !== null && !stopped && failure === null));
  // A turn answering notifications is one line until it has something to show.
  const handling = notificationRequest !== null && running && !shown;
  const requestLine =
    notificationRequest === null && notifications.length === 0 ? null : (
      <NotificationsLine
        notifications={notifications}
        request={notificationRequest}
        handling={handling}
        time={createdAt ?? null}
      />
    );
  // The events stay where they were given, whatever the turn said about them.
  if (silent || handling) {
    return <>{requestLine}</>;
  }

  return (
    <>
      {requestLine}
      <MessagePrimitive.Root asChild>
        <ChatAssistantMessage author={{ name: "Pi", time: createdAt ?? null }} footer={footer}>
          {shownTurn.map((segment) => {
            if (segment.kind === "said") {
              return segment.parts.map((part) =>
                part.kind === "text" ? (
                  <MarkdownText key={part.key} text={part.text} />
                ) : (
                  <MessageImage key={part.key} image={part.image} />
                ),
              );
            }
            return (
              <Fragment key={segment.key}>
                {segment.visibleSteps.length === 0 ? null : (
                  <ChatActivity
                    status={segment.status}
                    artifacts={
                      segment.artifactTool === null ? null : (
                        <ToolWorkspaceSelector
                          options={segment.artifactTool.workspaceOptions}
                          toolLabel={segment.artifactTool.presentation.label}
                          labelled
                        />
                      )
                    }
                  >
                    {segment.visibleSteps.map((step) => (
                      <TurnStep key={step.key} step={step} tools={toolsById} />
                    ))}
                  </ChatActivity>
                )}
                {segment.workflowRuns.map((run) => (
                  <SessionWorkflow key={run.instanceId} run={run} />
                ))}
                {segment.tools.map((tool) => (
                  <ToolCallSubagents key={tool.part.toolCallId} toolCallId={tool.part.toolCallId} />
                ))}
              </Fragment>
            );
          })}
          {working ? (
            <WorkingIndicator>{metadata.statusText ?? "Working…"}</WorkingIndicator>
          ) : null}
        </ChatAssistantMessage>
      </MessagePrimitive.Root>
    </>
  );
}

function turnTools(
  steps: readonly AgentTurnStep[],
  navigation: ReturnType<typeof useSessionWorkspaceNavigation>,
) {
  return steps.flatMap((step): TurnTool[] => {
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
}

/** The tool call that showed each run last, by run instance. */
function runsLastShowing(tools: readonly TurnTool[]) {
  const last = new Map<string, string>();
  for (const tool of tools) {
    for (const run of tool.presentation.codemodeDetails?.runs ?? []) {
      last.set(run.instanceId, tool.part.toolCallId);
    }
  }
  return last;
}

/** A run shown more than once in a list is one card, where it was shown last. */
function lastShownRuns(runs: readonly WorkflowRunReference[]) {
  const last = new Map<string, WorkflowRunReference>();
  for (const run of runs) {
    last.delete(run.instanceId);
    last.set(run.instanceId, run);
  }
  return [...last.values()];
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

/** Events no turn shows, where they were delivered, or the request no turn has answered yet. */
export function NotificationsMessage() {
  const createdAt = useAuiState((state) => state.message.createdAt);
  const { notifications, request } = useAuiState(
    (state) => state.message.metadata.custom as PiNotificationsMessageMetadata,
  );
  return (
    <MessagePrimitive.Root asChild>
      <div>
        <NotificationsLine
          notifications={notifications}
          request={request}
          handling={false}
          time={createdAt ?? null}
        />
      </div>
    </MessagePrimitive.Root>
  );
}

/**
 * The events the agent was given at one point, as one line. A subagent's report leads back to its
 * card, which shows its answer; other events open to what they carry. Several open to one line
 * each.
 */
function NotificationsLine({
  notifications,
  request,
  handling,
  time,
}: {
  notifications: readonly PiAgentNotification[];
  /** What the agent was asked to handle, for when the events it names are not shown. */
  request: readonly PiNotificationReference[] | null;
  handling: boolean;
  time: Date | null;
}) {
  const reports = useSubagentReports(notifications);
  const [first] = notifications;
  if (first === undefined || handling) {
    const label =
      first === undefined
        ? notificationRequestLabel(request ?? [], handling ? "handling" : "asked")
        : notificationsTitle(notifications, reports);
    return (
      <ChatEventDivider marker={handling ? "progress" : "notification"} time={time}>
        {handling ? <span className="bo-shimmer-text">{label}</span> : label}
      </ChatEventDivider>
    );
  }
  const [report] = reports;
  if (notifications.length === 1) {
    return report ? (
      <SubagentReportLine report={report} time={time} />
    ) : (
      <NotificationLine notification={first} time={time} />
    );
  }
  const tasks = reports.flatMap((each) => (each === null ? [] : [each.task]));
  return (
    <ChatEventDisclosure
      defaultOpen={false}
      marker="notification"
      title={notificationsTitle(notifications, reports)}
      note={tasks.length === notifications.length ? tasks.join(" · ") : null}
      time={time}
    >
      {notifications.map((notification, index) => {
        const each = reports[index];
        return each ? (
          <SubagentReportLine key={notificationKey(notification)} report={each} time={null} />
        ) : (
          <NotificationLine
            key={notificationKey(notification)}
            notification={notification}
            time={null}
          />
        );
      })}
    </ChatEventDisclosure>
  );
}

function notificationKey({ routeId, event }: PiAgentNotification) {
  return `${routeId ?? ""}:${event.id}`;
}

/** "2 subagents finished", or "3 notifications" for events of different kinds. */
function notificationsTitle(
  notifications: readonly PiAgentNotification[],
  reports: readonly (SubagentReport | null)[],
) {
  const outcomes = new Set(reports.map((report) => report?.outcome ?? null));
  if (notifications.length === 1) {
    const [report] = reports;
    return report
      ? `Subagent ${report.outcome}`
      : `${notifications[0].event.source} · ${notifications[0].event.eventType}`;
  }
  if (outcomes.has(null)) {
    return `${notifications.length} notifications`;
  }
  const [outcome] = outcomes;
  return `${notifications.length} subagents ${outcomes.size === 1 ? outcome : "ended"}`;
}

/** A subagent's report, which leads to its card rather than repeat its answer. */
function SubagentReportLine({ report, time }: { report: SubagentReport; time: Date | null }) {
  const marker =
    report.outcome === "finished"
      ? "live"
      : report.outcome === "failed"
        ? "failed"
        : "notification";
  if (report.show === null) {
    return (
      <ChatEventDivider marker={marker} time={time}>
        {`Subagent ${report.outcome} · ${report.task}`}
      </ChatEventDivider>
    );
  }
  return (
    <ChatEventLink
      marker={marker}
      title={`Subagent ${report.outcome}`}
      note={report.task}
      time={time}
      action="Show"
      onShow={report.show}
    />
  );
}

/**
 * An event delivered to the agent; expanding it shows the event's subject and payload. A
 * workflow's completion opens on its output when the output is an interface.
 */
function NotificationLine({
  notification,
  time,
}: {
  notification: PiAgentNotification;
  time: Date | null;
}) {
  const { resolvedScope, resolveScope } = useCurrentBackofficeContext();
  const agentScope = backofficeRuntimeScopeFromResolvedScope(resolvedScope);
  const completion = workflowCompletionFromNotification(notification.event, agentScope);
  // The conversation's runs are the agent's scope's; a run elsewhere may share an instance ID.
  const local = completion !== null && backofficeContextScopesEqual(completion.scope, agentScope);
  const run = useSessionRun(local ? completion.instanceId : null);
  const completionUi = completion === null ? null : parseBackofficeUiResult(completion.output);
  const output =
    completion !== null && completionUi !== null && completionUi.kind !== "ordinary"
      ? {
          parsed: completionUi,
          value: completion.output,
          // The run's files are in the scope it ran in.
          fileScope: resolveScope(completion.scope),
        }
      : null;
  const title = `${notification.event.source} · ${notification.event.eventType}`;

  // The run's card above holds its output, so the event leads back to it rather than repeat it.
  if (completion !== null && run !== null) {
    return (
      <ChatEventLink
        marker="live"
        title={title}
        note={completion.workflowName}
        time={time}
        action={output === null ? "View run" : "View result"}
        onShow={run.show}
      />
    );
  }

  return (
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
      time={time}
    >
      {output !== null ? (
        <FileScopeProvider scope={output.fileScope}>
          <ResultContent parsedValue={output.parsed} showRawValue={false} value={output.value}>
            {null}
          </ResultContent>
        </FileScopeProvider>
      ) : (
        <>
          <p className="mb-2 text-[10px] text-[var(--bo-muted-2)]">
            Event {notification.event.id},{" "}
            {notification.routeId === null
              ? "addressed to this agent."
              : "delivered by an automation route."}
          </p>
          <pre className="overflow-x-auto text-xs leading-5 whitespace-pre-wrap text-[var(--bo-muted)]">
            {JSON.stringify(
              { subject: notification.event.subject, payload: notification.event.payload },
              null,
              2,
            )}
          </pre>
        </>
      )}
    </ChatEventDisclosure>
  );
}
