import { Menu } from "@base-ui/react/menu";
import { Button } from "@fragno-private/design-system/button";
import { Icon } from "@fragno-private/design-system/icon";
import { useRef, useState, type UIEvent } from "react";

import { ComposerPrimitive, QueueItemPrimitive, ThreadPrimitive } from "@assistant-ui/react";

import { AssistantMessage, UserMessage } from "./messages";
import { tapScale } from "./ui";

const contextTokenFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

// Warns ahead of Pi's automatic compaction, which starts near the window minus its reserve.
const CONTEXT_USAGE_WARNING_RATIO = 0.8;

export function SessionThread({
  disabledReason,
  error,
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
  inactiveHistoryCount,
  hasMoreHistory,
  historyLoading,
  historyError,
  onComposerActionChange,
  onLoadMoreHistory,
}: {
  disabledReason: string | null;
  error: string | null;
  modelLabel: string;
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
  inactiveHistoryCount: number;
  hasMoreHistory: boolean;
  historyLoading: boolean;
  historyError: string | null;
  onComposerActionChange: (value: "message" | "compact") => void;
  onLoadMoreHistory: () => unknown;
}) {
  const disabled = disabledReason !== null;
  const viewportRef = useRef<HTMLDivElement>(null);
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
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col py-5 sm:py-8">
          {inactiveHistoryCount > 0 || hasMoreHistory || historyError ? (
            <section className="mb-5 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-xs text-[var(--bo-muted)]">
              <div className="flex min-h-8 items-center justify-between gap-3">
                <span>
                  <span className="font-medium text-[var(--bo-fg)]">Earlier history</span>
                  {inactiveHistoryCount > 0 ? (
                    <span className="ml-2 text-[10px] text-[var(--bo-muted-2)] tabular-nums">
                      {inactiveHistoryCount} inactive{" "}
                      {inactiveHistoryCount === 1 ? "entry" : "entries"}
                    </span>
                  ) : null}
                </span>
                {hasMoreHistory ? (
                  <Button
                    variant="ghost"
                    disabled={historyLoading}
                    onClick={() => void onLoadMoreHistory()}
                  >
                    {historyLoading ? "Loading…" : "Load older"}
                  </Button>
                ) : null}
              </div>
              <p className="text-[10px] leading-4 text-[var(--bo-muted-2)]">
                Entries shown here remain durable but are no longer part of Pi&apos;s active model
                context.
              </p>
              {historyError ? (
                <p role="alert" className="mt-2 text-[var(--bo-failed)]">
                  {historyError}
                </p>
              ) : null}
            </section>
          ) : null}

          <ThreadPrimitive.Messages>
            {({ message }) => {
              if (message.role === "user") {
                return <UserMessage />;
              }
              if (message.role === "assistant") {
                return (
                  <AssistantMessage
                    showThinking={showThinking}
                    showToolCalls={showToolCalls}
                    showUsage={showUsage}
                  />
                );
              }
              return null;
            }}
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
              {() => (
                <div className="mx-1 mb-1 flex items-baseline gap-2 border-l-2 border-[color:var(--bo-accent)] bg-[var(--bo-panel)] px-3 py-2 text-xs">
                  <span className="shrink-0 text-[9px] font-semibold tracking-[0.12em] text-[var(--bo-accent-fg)] uppercase">
                    Steering
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
                      <ComposerPrimitive.Send
                        disabled={disabled}
                        className={`inline-flex min-h-10 items-center border border-r-0 border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 text-xs font-semibold text-[var(--bo-accent-fg)] transition-[border-color,scale] duration-150 ease-out hover:border-[color:var(--bo-accent-strong)] disabled:cursor-not-allowed disabled:opacity-35 ${tapScale}`}
                      >
                        Send
                      </ComposerPrimitive.Send>
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
