import type {
  PiCompactionMessageMetadata,
  PiConversationQueueLabel,
  PiNotificationsMessageMetadata,
  PiResetMessageMetadata,
} from "@fragno-private/backoffice-conversation/projection/assistant-runtime";
import {
  ChatAttachmentDropZone,
  ChatComposerAttachButton,
  ChatComposerAttachments,
  type ChatComposerAttachmentItem,
} from "@fragno-private/design-system/agents/chat-attachment";
import {
  ChatComposer,
  ChatComposerButton,
  ChatComposerDictationButton,
  ChatComposerQueueItem,
  ChatComposerSplit,
  ChatComposerStatus,
  ChatComposerToolbar,
  chatComposerInputClassName,
} from "@fragno-private/design-system/agents/chat-composer";
import { ChatBoundaryDivider } from "@fragno-private/design-system/agents/chat-divider";
import {
  ChatColumn,
  ChatHistoryControls,
  ChatScrollToLatestButton,
  ChatThreadNotice,
  ChatTurnSpacer,
  ChatThread,
  ChatViewport,
  ChatViewportFooter,
} from "@fragno-private/design-system/agents/chat-thread";
import { ContextUsageMeter } from "@fragno-private/design-system/agents/context-usage-meter";
import { Button } from "@fragno-private/design-system/controls/button";
import { RadioMenu, type RadioMenuOption } from "@fragno-private/design-system/controls/radio-menu";
import { OperationNotice } from "@fragno-private/design-system/feedback/operation-notice";
import { useEffect, useRef, type ReactNode } from "react";

import {
  ComposerPrimitive,
  QueueItemPrimitive,
  ThreadPrimitive,
  useAuiState,
  useThreadViewport,
} from "@assistant-ui/react";

import { useChatExtensions } from "../extensions";
import {
  AssistantMessage,
  CompactionMessage,
  NotificationsMessage,
  ResetMessage,
  UserMessage,
} from "../messages/messages";

const OUT_OF_CONTEXT_HISTORY =
  "Earlier messages are still visible but out of context for the agent due to compaction or a reset.";
// Every other boundary starts at an entry a compaction kept.
const COMPACTED_HISTORY =
  "Earlier messages are still visible but out of context for the agent due to compaction.";
const CLEARED_HISTORY =
  "Context cleared. Earlier messages are still visible but out of context for the agent.";

/** What the composer's send does; clearing the context is no mode, it happens as it is chosen. */
export type ComposerAction = "message" | "compact";

/** What the reader does with the agent's context from the composer: compact it, or clear it. */
export type ContextControls = {
  action: ComposerAction;
  onActionChange: (value: ComposerAction) => void;
  onCompact: () => unknown;
  /** Starts the agent on a new, empty context; earlier messages stay in its history. */
  onClear: () => unknown;
  compactionError: string | null;
  compactionNotice: string | null;
  /** `window` is null when the session's model is missing from the available catalog. */
  usage: { tokens: number; window: number | null };
};

/** Files waiting to go with the next message; they upload as soon as they are added. */
export type ComposerAttachments = {
  items: readonly ChatComposerAttachmentItem[];
  add: (files: File[]) => void;
  /** Sends the files without text, which the composer's own send refuses. */
  sendFiles: () => void;
  /** A sent message is waiting for its files to finish uploading. */
  sending: boolean;
};

function composerActionOptions(
  readyForInput: boolean,
  contextEmpty: boolean,
): RadioMenuOption<ComposerAction | "clear">[] {
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
      description: "Start a new, empty context now; earlier messages stay in history",
      icon: null,
      // An empty active context, as right after a reset, has nothing to clear.
      disabled: !readyForInput || contextEmpty,
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

/** Sends what the composer holds, including files without text. */
function SendButton({
  label,
  joined,
  disabled,
  sendFiles,
}: {
  label: string;
  joined: boolean;
  disabled: boolean;
  /** Null while no files wait in the composer. */
  sendFiles: (() => void) | null;
}) {
  const empty = useAuiState((state) => state.composer.isEmpty);
  if (empty && sendFiles !== null) {
    return (
      <ChatComposerButton tone="accent" joined={joined} disabled={disabled} onClick={sendFiles}>
        {label}
      </ChatComposerButton>
    );
  }
  return (
    <ComposerPrimitive.Send disabled={disabled} asChild>
      <ChatComposerButton tone="accent" joined={joined}>
        {label}
      </ChatComposerButton>
    </ComposerPrimitive.Send>
  );
}

/** A paused queue resumes with an empty composer; a message resumes it too, at the queue's end. */
function SendOrResume({
  joined,
  disabled,
  paused,
  onResume,
  sendFiles,
}: {
  /** Joined to the menu of what the composer sends. */
  joined: boolean;
  disabled: boolean;
  paused: boolean;
  onResume: () => unknown;
  sendFiles: (() => void) | null;
}) {
  const empty = useAuiState((state) => state.composer.isEmpty);
  if (paused && empty && sendFiles === null) {
    return (
      <ChatComposerButton
        tone="accent"
        joined={joined}
        disabled={disabled}
        onClick={() => void onResume()}
      >
        Resume
      </ChatComposerButton>
    );
  }
  return <SendButton label="Send" joined={joined} disabled={disabled} sendFiles={sendFiles} />;
}

/** Sends or compacts, as the reader chose from its menu, which also clears the context. */
function ComposerActionSplit({
  context,
  disabled,
  readyForInput,
  compacting,
  paused,
  onResume,
  sendFiles,
}: {
  context: ContextControls;
  disabled: boolean;
  readyForInput: boolean;
  compacting: boolean;
  paused: boolean;
  onResume: () => unknown;
  sendFiles: (() => void) | null;
}) {
  return (
    <ChatComposerSplit>
      {context.action === "compact" ? (
        <ChatComposerButton
          tone="accent"
          joined
          disabled={disabled || !readyForInput || compacting}
          onClick={() => void context.onCompact()}
        >
          Compact
        </ChatComposerButton>
      ) : (
        <SendOrResume
          joined
          disabled={disabled}
          paused={paused}
          onResume={onResume}
          sendFiles={sendFiles}
        />
      )}
      <RadioMenu
        label="Choose composer action"
        heading="Composer action"
        trigger={{ kind: "accent" }}
        side="top"
        disabled={disabled}
        value={context.action}
        options={composerActionOptions(readyForInput, context.usage.tokens === 0)}
        onValueChange={(value) => {
          if (value === "clear") {
            void context.onClear();
          } else {
            context.onActionChange(value);
          }
        }}
      />
    </ChatComposerSplit>
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
  onContinue,
  onStop,
  readyForInput,
  running,
  subagentsRunning,
  showThinking,
  showToolCalls,
  showUsage,
  statusText,
  compacting,
  context,
  activeContextStartMessageId,
  hasMoreHistory,
  historyLoading,
  historyError,
  onLoadMoreHistory,
  dictation,
  attachments,
}: {
  disabledReason: string | null;
  error: string | null;
  /** Keyed by queue item id: steers join the running turn, everything else waits for a turn. */
  queueLabels: ReadonlyMap<string, PiConversationQueueLabel>;
  /**
   * Stopping the agent paused its queue with items or subagents waiting; sending anything resumes
   * it.
   */
  paused: boolean;
  onResume: () => unknown;
  /** The model answering, or a control choosing it; null shows none. */
  model: ReactNode;
  needsNudge: boolean;
  onContinue: () => unknown;
  onStop: () => unknown;
  readyForInput: boolean;
  running: boolean;
  /** Subagents run beside the conversation, so Stop shows while it is idle too; it stops them. */
  subagentsRunning: boolean;
  showThinking: boolean;
  showToolCalls: boolean;
  showUsage: boolean;
  statusText: string | null;
  /** The agent's context is being compacted, whoever started it. */
  compacting: boolean;
  /** Null where the reader leaves the agent's context to the agent. */
  context: ContextControls | null;
  /** The message the context divider precedes; null while no earlier history is shown. */
  activeContextStartMessageId: string | null;
  hasMoreHistory: boolean;
  historyLoading: boolean;
  historyError: string | null;
  onLoadMoreHistory: () => Promise<void>;
  /** Whether the runtime has a dictation adapter to drive the microphone button. */
  dictation: boolean;
  /** Null where the agent cannot read uploaded files. */
  attachments: ComposerAttachments | null;
}) {
  const { agentLabel, composerHeader } = useChatExtensions();
  const composerAction = context?.action ?? "message";
  const disabled = disabledReason !== null;
  // Clearing takes no text, so nothing can be written for it.
  // Compaction instructions and clearing say nothing to the agent, so carry no files.
  const attachingDisabled = disabled || composerAction !== "message" || attachments === null;
  // Files added while a message waits for its uploads go with the next message, after it.
  const sendFiles =
    attachments !== null && attachments.items.length > 0 && !attachments.sending
      ? attachments.sendFiles
      : null;
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
    <ChatAttachmentDropZone
      disabled={attachingDisabled}
      onFiles={(files) => {
        attachments?.add(files);
      }}
    >
      <ThreadPrimitive.Root asChild>
        <ChatThread>
          <ThreadPrimitive.Viewport ref={viewportRef} autoScroll asChild>
            <ChatViewport>
              <ChatColumn ref={contentRef}>
                {hasMoreHistory || historyError ? (
                  <ChatHistoryControls
                    // Once history shows, the divider below it carries this explanation.
                    explanation={
                      activeContextStartMessageId === null ? OUT_OF_CONTEXT_HISTORY : null
                    }
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
                        ? (message.metadata.custom as ChatSystemMessageMetadata).kind
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
                ) : context?.compactionError ? (
                  <ChatThreadNotice>
                    <OperationNotice
                      tone="failed"
                      title="Context compaction failed"
                      description={context.compactionError}
                      onRetry={context.onCompact}
                    />
                  </ChatThreadNotice>
                ) : context?.compactionNotice ? (
                  <ChatThreadNotice>
                    <OperationNotice
                      tone="neutral"
                      title="Context was not compacted"
                      description={context.compactionNotice}
                    />
                  </ChatThreadNotice>
                ) : null}
                <ChatTurnSpacer />
              </ChatColumn>

              <ThreadPrimitive.ViewportFooter asChild>
                <ChatViewportFooter alert={error}>
                  <ScrollToLatest />
                  {composerHeader}
                  <ComposerPrimitive.Root
                    onSubmit={(event) => {
                      if (context === null || composerAction === "message") {
                        return;
                      }
                      event.preventDefault();
                      if (composerAction === "compact" && readyForInput && !compacting) {
                        void context.onCompact();
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
                      {attachments === null ? null : (
                        <ChatComposerAttachments attachments={attachments.items} />
                      )}
                      <ComposerPrimitive.Input
                        disabled={disabled}
                        submitMode="enter"
                        placeholder={
                          disabled
                            ? disabledReason
                            : composerAction === "compact"
                              ? `Tell ${agentLabel} what the compaction summary must preserve`
                              : running
                                ? `Steer ${agentLabel}; it reads this after the current step`
                                : `Message ${agentLabel}`
                        }
                        rows={1}
                        className={chatComposerInputClassName}
                      />
                      <ChatComposerToolbar
                        start={
                          <>
                            {attachments === null ? null : (
                              <ChatComposerAttachButton
                                disabled={attachingDisabled}
                                onFiles={attachments.add}
                              />
                            )}
                            {model}
                            {context === null ? null : (
                              <ContextUsageMeter
                                tokens={context.usage.tokens}
                                contextWindow={context.usage.window}
                              />
                            )}
                            {disabled ? (
                              <ChatComposerStatus working={false}>
                                {disabledReason}
                              </ChatComposerStatus>
                            ) : running ? (
                              <ChatComposerStatus working>
                                {statusText ?? "Working…"}
                              </ChatComposerStatus>
                            ) : attachments?.sending ? (
                              <ChatComposerStatus working>Uploading files…</ChatComposerStatus>
                            ) : null}
                          </>
                        }
                        end={
                          <>
                            {dictation ? <DictationButton disabled={disabled} /> : null}
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
                                  <SendButton
                                    label="Steer"
                                    joined={false}
                                    disabled={disabled}
                                    sendFiles={sendFiles}
                                  />
                                )}
                              </>
                            ) : (
                              <>
                                {subagentsRunning ? (
                                  <ChatComposerButton
                                    tone="neutral"
                                    joined={false}
                                    onClick={() => void onStop()}
                                  >
                                    Stop
                                  </ChatComposerButton>
                                ) : null}
                                {context === null ? (
                                  <SendOrResume
                                    joined={false}
                                    disabled={disabled}
                                    paused={paused}
                                    onResume={onResume}
                                    sendFiles={sendFiles}
                                  />
                                ) : (
                                  <ComposerActionSplit
                                    context={context}
                                    disabled={disabled}
                                    readyForInput={readyForInput}
                                    compacting={compacting}
                                    paused={paused}
                                    onResume={onResume}
                                    sendFiles={sendFiles}
                                  />
                                )}
                              </>
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
    </ChatAttachmentDropZone>
  );
}

/** The chat's own system messages, or those of a kind the host adds, such as subagent batches. */
type ChatSystemMessageMetadata =
  | PiCompactionMessageMetadata
  | PiNotificationsMessageMetadata
  | PiResetMessageMetadata
  | { kind: string };

/** System messages are compactions, resets, events, or the host's; their metadata names which. */
function SystemMessage({ kind }: { kind: ChatSystemMessageMetadata["kind"] }) {
  const { systemMessages } = useChatExtensions();
  switch (kind) {
    case "notifications":
      return <NotificationsMessage />;
    case "compaction":
      return <CompactionMessage />;
    case "reset":
      return <ResetMessage />;
  }
  const HostMessage = systemMessages[kind];
  if (HostMessage === undefined) {
    throw new Error("Unsupported system message kind.");
  }
  return <HostMessage />;
}
