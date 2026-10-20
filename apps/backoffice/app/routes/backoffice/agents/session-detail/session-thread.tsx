import { Menu } from "@base-ui/react/menu";
import { Button } from "@fragno-private/design-system/button";
import { Icon } from "@fragno-private/design-system/icon";
import { useEffect, useRef, useState, type UIEvent } from "react";

import {
  ComposerPrimitive,
  QueueItemPrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";

import type {
  PiCompactionMessageMetadata,
  PiConversationQueueLabel,
  PiNotificationMessageMetadata,
  PiNotificationRequestMessageMetadata,
} from "./assistant-runtime";
import {
  AssistantMessage,
  CompactionMessage,
  NotificationMessage,
  NotificationRequestMessage,
  UserMessage,
} from "./messages";
import { tapScale } from "./ui";

const contextTokenFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const OUT_OF_CONTEXT_HISTORY =
  "Earlier messages are still visible but out of context for the agent due to compaction.";

// Warns ahead of Pi's automatic compaction, which starts near the window minus its reserve.
const CONTEXT_USAGE_WARNING_RATIO = 0.8;

const SEND_BUTTON_CLASS = `inline-flex min-h-10 items-center border border-r-0 border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 text-xs font-semibold text-[var(--bo-accent-fg)] transition-[border-color,scale] duration-150 ease-out hover:border-[color:var(--bo-accent-strong)] disabled:cursor-not-allowed disabled:opacity-35 ${tapScale}`;

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
      <button
        type="button"
        disabled={disabled}
        onClick={() => void onResume()}
        className={SEND_BUTTON_CLASS}
      >
        Resume
      </button>
    );
  }
  return (
    <ComposerPrimitive.Send disabled={disabled} className={SEND_BUTTON_CLASS}>
      Send
    </ComposerPrimitive.Send>
  );
}

const DICTATION_BUTTON_CLASS = `inline-flex min-h-10 w-10 items-center justify-center border transition-[border-color,color,scale] duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-35 ${tapScale}`;

/** Speech lands in the composer as the user talks; nothing is sent until they send it. */
function DictationButton({ disabled }: { disabled: boolean }) {
  const dictation = useAuiState((state) => state.composer.dictation?.status.type ?? null);
  if (dictation === null) {
    return (
      <ComposerPrimitive.Dictate
        disabled={disabled}
        aria-label="Dictate"
        title="Dictate"
        className={`${DICTATION_BUTTON_CLASS} border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] text-[var(--bo-muted)] hover:border-[color:var(--bo-accent)] hover:text-[var(--bo-fg)]`}
      >
        <Icon name="mic" className="size-4" />
      </ComposerPrimitive.Dictate>
    );
  }
  return (
    <ComposerPrimitive.StopDictation
      aria-label="Stop dictation"
      title="Stop dictation"
      className={`${DICTATION_BUTTON_CLASS} border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]`}
    >
      {/* The microphone stays until Reson8 is listening, then turns into a stop control. */}
      {dictation === "running" ? (
        <span className="size-2.5 animate-pulse bg-[var(--bo-accent)]" />
      ) : (
        <Icon name="mic" className="size-4" />
      )}
    </ComposerPrimitive.StopDictation>
  );
}

export function SessionThread({
  disabledReason,
  error,
  queueLabels,
  paused,
  onResume,
  modelLabel,
  needsNudge,
  onCompact,
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
  modelLabel: string | null;
  needsNudge: boolean;
  onCompact: () => unknown;
  onContinue: () => unknown;
  onStop: () => unknown;
  readyForInput: boolean;
  running: boolean;
  showThinking: boolean;
  showToolCalls: boolean;
  showUsage: boolean;
  statusText: string | null;
  composerAction: "message" | "compact";
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
  onComposerActionChange: (value: "message" | "compact") => void;
  onLoadMoreHistory: () => Promise<void>;
  /** Whether the runtime has a dictation adapter to drive the microphone button. */
  dictation: boolean;
}) {
  const disabled = disabledReason !== null;
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
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);

  const handleViewportScroll = (event: UIEvent<HTMLDivElement>) => {
    const viewport = event.currentTarget;
    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    setShowScrollToLatest(distanceFromBottom > 32);
  };

  const scrollToLatest = () => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  };

  return (
    <ThreadPrimitive.Root className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--bo-bg)]">
      <ThreadPrimitive.Viewport
        ref={viewportRef}
        autoScroll
        turnAnchor="top"
        onScroll={handleViewportScroll}
        className="backoffice-scroll flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain scroll-smooth px-3 sm:px-6"
      >
        <div
          ref={contentRef}
          className="mx-auto flex w-full max-w-3xl flex-1 flex-col py-5 sm:py-8"
        >
          {hasMoreHistory || historyError ? (
            <section className="mb-7 flex flex-col items-center gap-2 text-center text-xs text-[var(--bo-muted)]">
              {/* Once history shows, the divider below it carries this explanation. */}
              {activeContextStartMessageId === null ? (
                <p className="text-pretty">{OUT_OF_CONTEXT_HISTORY}</p>
              ) : null}
              {hasMoreHistory ? (
                <Button
                  variant="ghost"
                  disabled={historyLoading}
                  onClick={() => void loadOlderHistory()}
                >
                  {historyLoading ? "Loading…" : "Load older"}
                </Button>
              ) : null}
              {historyError ? (
                <p role="alert" className="text-pretty text-[var(--bo-failed)]">
                  {historyError}
                </p>
              ) : null}
            </section>
          ) : null}

          <ThreadPrimitive.Messages>
            {({ message }) => (
              <>
                {message.id === activeContextStartMessageId ? <ContextBoundaryDivider /> : null}
                {message.role === "user" ? (
                  <UserMessage />
                ) : message.role === "assistant" ? (
                  <AssistantMessage
                    showThinking={showThinking}
                    showToolCalls={showToolCalls}
                    showUsage={showUsage}
                  />
                ) : (
                  <SystemMessage
                    kind={
                      (
                        message.metadata.custom as
                          | PiCompactionMessageMetadata
                          | PiNotificationMessageMetadata
                          | PiNotificationRequestMessageMetadata
                      ).kind
                    }
                  />
                )}
              </>
            )}
          </ThreadPrimitive.Messages>

          {compacting ? <CompactionOperationIndicator /> : null}
          {compactionError && !compacting ? (
            <CompactionOperationFailure message={compactionError} onRetry={onCompact} />
          ) : compactionNotice && !compacting ? (
            <CompactionOperationNotice message={compactionNotice} />
          ) : null}
        </div>

        <ThreadPrimitive.ViewportFooter className="sticky bottom-0 z-20 mx-auto w-full max-w-3xl bg-[linear-gradient(to_bottom,transparent,var(--bo-bg)_1.5rem)] pt-8 pb-3 sm:pb-5">
          {error ? (
            <p className="mb-2 border border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] px-3 py-2 text-xs text-pretty text-[var(--bo-failed)]">
              {error}
            </p>
          ) : null}

          <ComposerPrimitive.Root
            aria-disabled={disabled}
            onSubmit={(event) => {
              if (composerAction !== "compact") {
                return;
              }
              event.preventDefault();
              if (readyForInput) {
                void onCompact();
              }
            }}
            className={`border bg-[var(--bo-panel-2)] p-2 transition-[border-color,opacity] duration-150 ${disabled ? "cursor-not-allowed border-[color:var(--bo-border)] opacity-50" : "border-[color:var(--bo-border-strong)]"}`}
          >
            <ComposerPrimitive.Queue>
              {({ queueItem }) => (
                <div className="mx-1 mb-1 flex items-baseline gap-2 border-l-2 border-[color:var(--bo-accent)] bg-[var(--bo-panel)] px-3 py-2 text-xs">
                  <span className="shrink-0 text-[9px] font-semibold tracking-[0.12em] text-[var(--bo-accent-fg)] uppercase">
                    {queueLabels.get(queueItem.id)}
                  </span>
                  <QueueItemPrimitive.Text className="line-clamp-2 min-w-0 text-pretty whitespace-pre-wrap text-[var(--bo-fg)]" />
                </div>
              )}
            </ComposerPrimitive.Queue>
            <ComposerPrimitive.Input
              disabled={disabled}
              submitMode="enter"
              placeholder={
                disabled
                  ? disabledReason
                  : composerAction === "compact"
                    ? "Tell Pi what the compaction summary must preserve"
                    : running
                      ? "Steer Pi; it reads this after the current step"
                      : "Message Pi"
              }
              rows={1}
              className="max-h-48 min-h-14 w-full resize-none bg-transparent px-3 py-3 text-[15px] leading-6 text-[var(--bo-fg)] outline-none placeholder:text-[var(--bo-muted-2)] disabled:cursor-not-allowed"
            />
            <div className="flex min-h-10 items-center justify-between gap-2 px-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="hidden max-w-44 truncate px-2 text-[10px] text-[var(--bo-muted-2)] sm:block">
                  {modelLabel}
                </span>
                <ContextUsageIndicator usage={contextUsage} />
                {disabled ? (
                  <span className="hidden text-xs text-[var(--bo-muted-2)] sm:inline">
                    {disabledReason}
                  </span>
                ) : running ? (
                  <span className="hidden items-center gap-2 text-xs text-[var(--bo-muted-2)] sm:inline-flex">
                    <span className="size-1.5 animate-pulse rounded-full bg-[var(--bo-accent)]" />
                    {statusText ?? "Working…"}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-1">
                {dictation ? <DictationButton disabled={disabled} /> : null}
                {needsNudge ? (
                  <Button variant="ghost" onClick={() => void onContinue()}>
                    Continue
                  </Button>
                ) : null}
                {running ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void onStop()}
                      className={`inline-flex min-h-10 items-center border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] px-3 text-xs font-semibold text-[var(--bo-fg)] transition-[border-color,scale] duration-150 ease-out hover:border-[color:var(--bo-failed)] ${tapScale}`}
                    >
                      Stop
                    </button>
                    {compacting ? null : (
                      <ComposerPrimitive.Send
                        disabled={disabled}
                        className={`inline-flex min-h-10 items-center border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 text-xs font-semibold text-[var(--bo-accent-fg)] transition-[border-color,scale] duration-150 ease-out hover:border-[color:var(--bo-accent-strong)] disabled:cursor-not-allowed disabled:opacity-35 ${tapScale}`}
                      >
                        Steer
                      </ComposerPrimitive.Send>
                    )}
                  </>
                ) : (
                  <div className="flex items-stretch">
                    {composerAction === "compact" ? (
                      <button
                        type="button"
                        disabled={disabled || !readyForInput}
                        onClick={() => void onCompact()}
                        className={`inline-flex min-h-10 items-center border border-r-0 border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 text-xs font-semibold text-[var(--bo-accent-fg)] transition-[border-color,scale] duration-150 ease-out hover:border-[color:var(--bo-accent-strong)] disabled:cursor-not-allowed disabled:opacity-35 ${tapScale}`}
                      >
                        Compact
                      </button>
                    ) : (
                      <SendOrResume disabled={disabled} paused={paused} onResume={onResume} />
                    )}
                    <Menu.Root modal={false}>
                      <Menu.Trigger
                        type="button"
                        disabled={disabled}
                        aria-label="Choose composer action"
                        title="Choose composer action"
                        className={`inline-flex min-h-10 w-9 items-center justify-center border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)] transition-[background-color,scale] duration-150 ease-out outline-none hover:bg-[var(--bo-panel)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/25 disabled:cursor-not-allowed disabled:opacity-35 data-[popup-open]:bg-[var(--bo-panel)] ${tapScale}`}
                      >
                        <Icon name="chevron-down" className="size-3.5" />
                      </Menu.Trigger>
                      <Menu.Portal>
                        <Menu.Positioner side="top" align="end" sideOffset={8} className="z-50">
                          <Menu.Popup
                            data-backoffice-root
                            className="bo-popover-surface w-72 origin-bottom-right bg-[var(--bo-panel)] p-2 text-[var(--bo-fg)] outline-none"
                          >
                            <p className="px-2.5 py-1 text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                              Composer action
                            </p>
                            <Menu.RadioGroup
                              value={composerAction}
                              onValueChange={(value: unknown) => {
                                if (value === "message" || value === "compact") {
                                  onComposerActionChange(value);
                                }
                              }}
                              className="space-y-1"
                            >
                              <ComposerActionItem
                                value="message"
                                label="Send message"
                                description="Start or continue the conversation"
                              />
                              <ComposerActionItem
                                value="compact"
                                label="Compact context"
                                description="Summarize durable history using the instructions above"
                                disabled={!readyForInput}
                              />
                            </Menu.RadioGroup>
                          </Menu.Popup>
                        </Menu.Positioner>
                      </Menu.Portal>
                    </Menu.Root>
                  </div>
                )}
              </div>
            </div>
          </ComposerPrimitive.Root>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>

      {showScrollToLatest ? (
        <Button
          variant="secondary"
          onClick={scrollToLatest}
          className="absolute bottom-[10.5rem] left-1/2 z-30 -translate-x-1/2 shadow-[var(--bo-popover-shadow)]"
        >
          Scroll to latest
        </Button>
      ) : null}
    </ThreadPrimitive.Root>
  );
}

function ContextUsageIndicator({ usage }: { usage: { tokens: number; window: number | null } }) {
  const tokens = contextTokenFormatter.format(usage.tokens);
  if (usage.window === null) {
    return (
      <span
        title={`${usage.tokens.toLocaleString()} estimated context tokens`}
        className="border-l border-[color:var(--bo-border)] px-2 text-[10px] text-[var(--bo-muted-2)] tabular-nums"
      >
        {tokens} context
      </span>
    );
  }
  const ratio = usage.tokens / usage.window;
  return (
    <span
      title={`${usage.tokens.toLocaleString()} of ${usage.window.toLocaleString()} estimated context tokens`}
      className={`border-l border-[color:var(--bo-border)] px-2 text-[10px] tabular-nums ${ratio >= CONTEXT_USAGE_WARNING_RATIO ? "text-[var(--bo-waiting)]" : "text-[var(--bo-muted-2)]"}`}
    >
      {Math.min(100, Math.round(ratio * 100))}% context
    </span>
  );
}

/** Separates loaded history from the messages still in the agent's context. */
function ContextBoundaryDivider() {
  return (
    <div role="separator" className="my-12 flex items-center gap-5 text-xs text-[var(--bo-muted)]">
      <span className="h-px min-w-8 flex-1 bg-[var(--bo-border-strong)]" />
      <span className="text-center text-pretty sm:whitespace-nowrap">{OUT_OF_CONTEXT_HISTORY}</span>
      <span className="h-px min-w-8 flex-1 bg-[var(--bo-border-strong)]" />
    </div>
  );
}

function CompactionOperationIndicator() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-3 flex min-h-12 items-center gap-3 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 text-xs text-[var(--bo-muted)]"
    >
      <span className="size-1.5 shrink-0 animate-pulse bg-[var(--bo-accent)]" />
      <span>
        <span className="block font-medium text-[var(--bo-fg)]">Compacting context</span>
        <span className="mt-0.5 block text-[10px] text-[var(--bo-muted-2)]">
          Selecting history and writing a durable summary…
        </span>
      </span>
    </div>
  );
}

function CompactionOperationNotice({ message }: { message: string }) {
  return (
    <div
      role="status"
      className="mb-3 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-xs text-[var(--bo-muted)]"
    >
      <span className="block font-medium text-[var(--bo-fg)]">Context was not compacted</span>
      <span className="mt-0.5 block text-[10px] text-[var(--bo-muted-2)]">{message}</span>
    </div>
  );
}

function CompactionOperationFailure({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => unknown;
}) {
  return (
    <div
      role="alert"
      className="mb-3 flex min-h-12 items-center justify-between gap-3 border border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] px-3 py-2 text-xs text-[var(--bo-failed)]"
    >
      <span className="min-w-0 text-pretty">
        <span className="block font-medium">Context compaction failed</span>
        <span className="mt-0.5 block text-[10px] opacity-80">{message}</span>
      </span>
      <button
        type="button"
        onClick={() => void onRetry()}
        className={`inline-flex min-h-10 shrink-0 items-center px-3 text-[10px] font-semibold transition-[background-color,scale] duration-150 ease-out hover:bg-[var(--bo-panel)] ${tapScale}`}
      >
        Retry
      </button>
    </div>
  );
}

function ComposerActionItem({
  description,
  disabled = false,
  label,
  value,
}: {
  description: string;
  disabled?: boolean;
  label: string;
  value: "message" | "compact";
}) {
  return (
    <Menu.RadioItem
      value={value}
      disabled={disabled}
      className="grid min-h-14 cursor-default grid-cols-[1fr_1rem] items-center gap-3 px-2.5 text-left transition-[background-color,color,opacity,scale] duration-150 ease-out outline-none active:scale-[0.98] data-[disabled]:opacity-35 data-[highlighted]:bg-[var(--bo-panel-2)]"
    >
      <span className="min-w-0">
        <span className="block text-xs font-medium text-[var(--bo-fg)]">{label}</span>
        <span className="mt-0.5 block text-[10px] leading-4 text-[var(--bo-muted-2)]">
          {description}
        </span>
      </span>
      <Menu.RadioItemIndicator className="text-[var(--bo-accent-fg)]">
        <Icon name="check" className="size-4" />
      </Menu.RadioItemIndicator>
    </Menu.RadioItem>
  );
}

/** System messages are compactions or notifications; their metadata names which. */
function SystemMessage({
  kind,
}: {
  kind: (
    | PiCompactionMessageMetadata
    | PiNotificationMessageMetadata
    | PiNotificationRequestMessageMetadata
  )["kind"];
}) {
  switch (kind) {
    case "notification":
      return <NotificationMessage />;
    case "notification-request":
      return <NotificationRequestMessage />;
    case "compaction":
      return <CompactionMessage />;
  }
  throw new Error("Unsupported system message kind.");
}
