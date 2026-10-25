import { Button } from "@fragno-private/design-system/button";
import {
  ChatComposer,
  ChatComposerButton,
  ChatComposerDictationButton,
  ChatComposerQueueItem,
  ChatComposerSplit,
  ChatComposerStatus,
  ChatComposerToolbar,
  chatComposerInputClassName,
} from "@fragno-private/design-system/chat-composer";
import { ChatBoundaryDivider } from "@fragno-private/design-system/chat-divider";
import {
  ChatColumn,
  ChatHistoryControls,
  ChatScrollToLatestButton,
  ChatThreadNotice,
  ChatTurnSpacer,
  ChatThread,
  ChatViewport,
  ChatViewportFooter,
} from "@fragno-private/design-system/chat-thread";
import { ContextUsageMeter } from "@fragno-private/design-system/context-usage-meter";
import { OperationNotice } from "@fragno-private/design-system/operation-notice";
import { RadioMenu, type RadioMenuOption } from "@fragno-private/design-system/radio-menu";
import { useEffect, useRef, type ReactNode } from "react";

import {
  ComposerPrimitive,
  QueueItemPrimitive,
  ThreadPrimitive,
  useAuiState,
  useThreadViewport,
} from "@assistant-ui/react";

import type {
  PiCompactionMessageMetadata,
  PiConversationQueueLabel,
  PiNotificationMessageMetadata,
  PiNotificationRequestMessageMetadata,
  PiResetMessageMetadata,
} from "./assistant-runtime";
import {
  AssistantMessage,
  CompactionMessage,
  NotificationMessage,
  NotificationRequestMessage,
  ResetMessage,
  UserMessage,
} from "./messages";
import { SessionWorkflowInputRequests } from "./session-workflow";

const OUT_OF_CONTEXT_HISTORY =
  "Earlier messages are still visible but out of context for the agent due to compaction or a reset.";
// Every other boundary starts at an entry a compaction kept.
const COMPACTED_HISTORY =
  "Earlier messages are still visible but out of context for the agent due to compaction.";
const CLEARED_HISTORY =
  "Context cleared. Earlier messages are still visible but out of context for the agent.";

export type ComposerAction = "message" | "compact" | "clear";

function composerActionOptions(readyForInput: boolean): RadioMenuOption<ComposerAction>[] {
  return [
    {
      value: "message",
      label: "Send message",
      description: "Start or continue the conversation",
      icon: null,
      disabled: false,
    },
    {
      value: "compact",
      label: "Compact context",
      description: "Summarize durable history using the instructions above",
      icon: null,
      disabled: !readyForInput,
    },
    {
      value: "clear",
      label: "Clear context",
      description: "Start a new, empty context; earlier messages stay in history",
      icon: null,
      disabled: !readyForInput,
    },
  ];
}

/**
 * The runtime scrolls to the newest message and keeps chasing it while a reply streams, then
 * follows the reply; a scroll of its own would stop short and leave the thread unfollowed. The
 * jump is instant because each streamed chunk would restart a smooth scroll.
 */
function ScrollToLatest() {
  const atBottom = useThreadViewport((viewport) => viewport.isAtBottom);
  if (atBottom) {
    return null;
  }
  return (
    <ThreadPrimitive.ScrollToBottom behavior="instant" asChild>
      <ChatScrollToLatestButton />
    </ThreadPrimitive.ScrollToBottom>
  );
}

/** A paused queue resumes with an empty composer; a message resumes it too, at the queue's end. */
function SendOrResume({
  disabled,
  paused,
  onResume,
}: {
  disabled: boolean;
  paused: boolean;
  onResume: () => unknown;
}) {
  const empty = useAuiState((state) => state.composer.isEmpty);
  if (paused && empty) {
    return (
      <ChatComposerButton tone="accent" joined disabled={disabled} onClick={() => void onResume()}>
        Resume
      </ChatComposerButton>
    );
  }
  return (
    <ComposerPrimitive.Send disabled={disabled} asChild>
      <ChatComposerButton tone="accent" joined>
        Send
      </ChatComposerButton>
    </ComposerPrimitive.Send>
  );
}

/** Speech lands in the composer as the user talks; nothing is sent until they send it. */
function DictationButton({ disabled }: { disabled: boolean }) {
  const dictation = useAuiState((state) => state.composer.dictation?.status.type ?? null);
  if (dictation === null) {
    return (
      <ComposerPrimitive.Dictate disabled={disabled} asChild>
        <ChatComposerDictationButton state="idle" aria-label="Dictate" title="Dictate" />
      </ComposerPrimitive.Dictate>
    );
  }
  return (
    <ComposerPrimitive.StopDictation asChild>
      <ChatComposerDictationButton
        state={dictation === "running" ? "listening" : "starting"}
        aria-label="Stop dictation"
        title="Stop dictation"
      />
    </ComposerPrimitive.StopDictation>
  );
}

export function SessionThread({
  disabledReason,
  error,
  queueLabels,
  paused,
  onResume,
  model,
  needsNudge,
  onCompact,
  onClear,
  onContinue,
  onStop,
  readyForInput,
  running,
  showThinking,
  showToolCalls,
  showUsage,
  statusText,
  composerAction,
  compacting,
  compactionError,
  compactionNotice,
  contextUsage,
  activeContextStartMessageId,
  hasMoreHistory,
  historyLoading,
  historyError,
  onComposerActionChange,
  onLoadMoreHistory,
  dictation,
}: {
  disabledReason: string | null;
  error: string | null;
  /** Keyed by queue item id: steers join the running turn, everything else waits for a turn. */
  queueLabels: ReadonlyMap<string, PiConversationQueueLabel>;
  /** Stopping the agent paused its queue with items waiting; sending anything resumes it. */
  paused: boolean;
  onResume: () => unknown;
  /** The model answering, or a control choosing it; null shows none. */
  model: ReactNode;
  needsNudge: boolean;
  onCompact: () => unknown;
  /** Starts the agent on a new, empty context; earlier messages stay in its history. */
  onClear: () => unknown;
  onContinue: () => unknown;
  onStop: () => unknown;
  readyForInput: boolean;
  running: boolean;
  showThinking: boolean;
  showToolCalls: boolean;
  showUsage: boolean;
  statusText: string | null;
  composerAction: ComposerAction;
  compacting: boolean;
  compactionError: string | null;
  compactionNotice: string | null;
  /** `window` is null when the session's model is missing from the available catalog. */
  contextUsage: { tokens: number; window: number | null };
  /** The message the context divider precedes; null while no earlier history is shown. */
  activeContextStartMessageId: string | null;
  hasMoreHistory: boolean;
  historyLoading: boolean;
  historyError: string | null;
  onComposerActionChange: (value: ComposerAction) => void;
  onLoadMoreHistory: () => Promise<void>;
  /** Whether the runtime has a dictation adapter to drive the microphone button. */
  dictation: boolean;
}) {
  const disabled = disabledReason !== null;
  // Clearing takes no text, so nothing can be written for it.
  const writingDisabled = disabled || composerAction === "clear";
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // While older history loads, the reader's distance from the bottom stays fixed, so content
  // inserted above them does not move what they are reading.
  const historyScrollAnchorRef = useRef<number | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) {
      return undefined;
    }
    const observer = new ResizeObserver(() => {
      const distanceFromBottom = historyScrollAnchorRef.current;
      if (distanceFromBottom !== null) {
        viewport.scrollTo({ top: viewport.scrollHeight - distanceFromBottom, behavior: "instant" });
      }
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
    };
  }, []);

  const loadOlderHistory = async () => {
    const viewport = viewportRef.current;
    historyScrollAnchorRef.current = viewport ? viewport.scrollHeight - viewport.scrollTop : null;
    try {
      await onLoadMoreHistory();
    } finally {
      // The loaded entries reach the thread over a render or two after the request settles.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          historyScrollAnchorRef.current = null;
        });
      });
    }
  };
  return (
    <ThreadPrimitive.Root asChild>
      <ChatThread>
        <ThreadPrimitive.Viewport ref={viewportRef} autoScroll asChild>
          <ChatViewport>
            <ChatColumn ref={contentRef}>
              {hasMoreHistory || historyError ? (
                <ChatHistoryControls
                  // Once history shows, the divider below it carries this explanation.
                  explanation={activeContextStartMessageId === null ? OUT_OF_CONTEXT_HISTORY : null}
                  hasMore={hasMoreHistory}
                  loading={historyLoading}
                  error={historyError}
                  onLoadMore={() => void loadOlderHistory()}
                />
              ) : null}

              <ThreadPrimitive.Messages>
                {({ message }) => {
                  const systemKind =
                    message.role === "system"
                      ? (
                          message.metadata.custom as
                            | PiCompactionMessageMetadata
                            | PiNotificationMessageMetadata
                            | PiNotificationRequestMessageMetadata
                            | PiResetMessageMetadata
                        ).kind
                      : null;
                  // A context that starts at a reset needs one boundary, not the reset's marker too.
                  if (message.id === activeContextStartMessageId && systemKind === "reset") {
                    return <ChatBoundaryDivider>{CLEARED_HISTORY}</ChatBoundaryDivider>;
                  }
                  return (
                    <>
                      {message.id === activeContextStartMessageId ? (
                        <ChatBoundaryDivider>{COMPACTED_HISTORY}</ChatBoundaryDivider>
                      ) : null}
                      {systemKind !== null ? (
                        <SystemMessage kind={systemKind} />
                      ) : message.role === "user" ? (
                        <UserMessage />
                      ) : (
                        <AssistantMessage
                          showThinking={showThinking}
                          showToolCalls={showToolCalls}
                          showUsage={showUsage}
                        />
                      )}
                    </>
                  );
                }}
              </ThreadPrimitive.Messages>

              {compacting ? (
                <ChatThreadNotice>
                  <OperationNotice
                    tone="progress"
                    title="Compacting context"
                    description="Selecting history and writing a durable summary…"
                  />
                </ChatThreadNotice>
              ) : compactionError ? (
                <ChatThreadNotice>
                  <OperationNotice
                    tone="failed"
                    title="Context compaction failed"
                    description={compactionError}
                    onRetry={onCompact}
                  />
                </ChatThreadNotice>
              ) : compactionNotice ? (
                <ChatThreadNotice>
                  <OperationNotice
                    tone="neutral"
                    title="Context was not compacted"
                    description={compactionNotice}
                  />
                </ChatThreadNotice>
              ) : null}
              <ChatTurnSpacer />
            </ChatColumn>

            <ThreadPrimitive.ViewportFooter asChild>
              <ChatViewportFooter alert={error}>
                <ScrollToLatest />
                <SessionWorkflowInputRequests />
                <ComposerPrimitive.Root
                  onSubmit={(event) => {
                    if (composerAction === "message") {
                      return;
                    }
                    event.preventDefault();
                    if (composerAction === "compact" && readyForInput) {
                      void onCompact();
                    }
                  }}
                  asChild
                >
                  <ChatComposer disabled={disabled}>
                    <ComposerPrimitive.Queue>
                      {({ queueItem }) => (
                        <ChatComposerQueueItem label={queueLabels.get(queueItem.id)}>
                          <QueueItemPrimitive.Text />
                        </ChatComposerQueueItem>
                      )}
                    </ComposerPrimitive.Queue>
                    <ComposerPrimitive.Input
                      disabled={writingDisabled}
                      submitMode="enter"
                      placeholder={
                        disabled
                          ? disabledReason
                          : composerAction === "compact"
                            ? "Tell Pi what the compaction summary must preserve"
                            : composerAction === "clear"
                              ? "Clear starts Pi on a new, empty context"
                              : running
                                ? "Steer Pi; it reads this after the current step"
                                : "Message Pi"
                      }
                      rows={1}
                      className={chatComposerInputClassName}
                    />
                    <ChatComposerToolbar
                      start={
                        <>
                          {model}
                          <ContextUsageMeter
                            tokens={contextUsage.tokens}
                            contextWindow={contextUsage.window}
                          />
                          {disabled ? (
                            <ChatComposerStatus working={false}>
                              {disabledReason}
                            </ChatComposerStatus>
                          ) : running ? (
                            <ChatComposerStatus working>
                              {statusText ?? "Working…"}
                            </ChatComposerStatus>
                          ) : null}
                        </>
                      }
                      end={
                        <>
                          {dictation ? <DictationButton disabled={writingDisabled} /> : null}
                          {needsNudge ? (
                            <Button variant="ghost" onClick={() => void onContinue()}>
                              Continue
                            </Button>
                          ) : null}
                          {running ? (
                            <>
                              <ChatComposerButton
                                tone="neutral"
                                joined={false}
                                onClick={() => void onStop()}
                              >
                                Stop
                              </ChatComposerButton>
                              {compacting ? null : (
                                <ComposerPrimitive.Send disabled={disabled} asChild>
                                  <ChatComposerButton tone="accent" joined={false}>
                                    Steer
                                  </ChatComposerButton>
                                </ComposerPrimitive.Send>
                              )}
                            </>
                          ) : (
                            <ChatComposerSplit>
                              {composerAction === "compact" ? (
                                <ChatComposerButton
                                  tone="accent"
                                  joined
                                  disabled={disabled || !readyForInput}
                                  onClick={() => void onCompact()}
                                >
                                  Compact
                                </ChatComposerButton>
                              ) : composerAction === "clear" ? (
                                <ChatComposerButton
                                  tone="accent"
                                  joined
                                  // An empty active context, as right after a reset, has nothing to clear.
                                  disabled={disabled || !readyForInput || contextUsage.tokens === 0}
                                  onClick={() => void onClear()}
                                >
                                  Clear
                                </ChatComposerButton>
                              ) : (
                                <SendOrResume
                                  disabled={disabled}
                                  paused={paused}
                                  onResume={onResume}
                                />
                              )}
                              <RadioMenu
                                label="Choose composer action"
                                heading="Composer action"
                                trigger={{ kind: "accent" }}
                                side="top"
                                disabled={disabled}
                                value={composerAction}
                                options={composerActionOptions(readyForInput)}
                                onValueChange={onComposerActionChange}
                              />
                            </ChatComposerSplit>
                          )}
                        </>
                      }
                    />
                  </ChatComposer>
                </ComposerPrimitive.Root>
              </ChatViewportFooter>
            </ThreadPrimitive.ViewportFooter>
          </ChatViewport>
        </ThreadPrimitive.Viewport>
      </ChatThread>
    </ThreadPrimitive.Root>
  );
}

/** System messages are compactions, resets, or notifications; their metadata names which. */
function SystemMessage({
  kind,
}: {
  kind: (
    | PiCompactionMessageMetadata
    | PiNotificationMessageMetadata
    | PiNotificationRequestMessageMetadata
    | PiResetMessageMetadata
  )["kind"];
}) {
  switch (kind) {
    case "notification":
      return <NotificationMessage />;
    case "notification-request":
      return <NotificationRequestMessage />;
    case "compaction":
      return <CompactionMessage />;
    case "reset":
      return <ResetMessage />;
  }
  throw new Error("Unsupported system message kind.");
}
