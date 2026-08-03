import { useRef, useState, type UIEvent } from "react";

import { ComposerPrimitive, ThreadPrimitive } from "@assistant-ui/react";

import { AssistantMessage, UserMessage } from "./messages";
import { tapScale } from "./ui";

export function SessionThread({
  disabledReason,
  error,
  modelLabel,
  needsNudge,
  onContinue,
  onStop,
  readyForInput,
  running,
  showThinking,
  showToolCalls,
  showUsage,
  statusText,
  commandKind,
  onCommandKindChange,
}: {
  disabledReason: string | null;
  error: string | null;
  modelLabel: string;
  needsNudge: boolean;
  onContinue: () => unknown;
  onStop: () => unknown;
  readyForInput: boolean;
  running: boolean;
  showThinking: boolean;
  showToolCalls: boolean;
  showUsage: boolean;
  statusText: string | null;
  commandKind: "followUp" | "steer";
  onCommandKindChange: (value: "followUp" | "steer") => void;
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
    <ThreadPrimitive.Root className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--bo-panel)]">
      <ThreadPrimitive.Viewport
        ref={viewportRef}
        autoScroll
        turnAnchor="top"
        onScroll={handleViewportScroll}
        className="backoffice-scroll flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain scroll-smooth px-3 sm:px-6"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col py-5 sm:py-8">
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
        </div>

        <ThreadPrimitive.ViewportFooter className="sticky bottom-0 z-20 mx-auto w-full max-w-3xl bg-[linear-gradient(to_bottom,transparent,var(--bo-panel)_1.5rem)] pt-8 pb-3 sm:pb-5">
          {error ? (
            <p className="mb-2 border border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] px-3 py-2 text-xs text-pretty text-[var(--bo-failed)]">
              {error}
            </p>
          ) : null}

          <ComposerPrimitive.Root
            aria-disabled={disabled}
            className={`border bg-[var(--bo-panel-2)] p-2 transition-[border-color,opacity] duration-150 ${disabled ? "cursor-not-allowed border-[color:var(--bo-border)] opacity-50" : "border-[color:var(--bo-border-strong)] focus-within:border-[color:var(--bo-accent)] focus-within:ring-2 focus-within:ring-[color:var(--bo-accent)]/15"}`}
          >
            <ComposerPrimitive.Input
              disabled={disabled}
              submitMode="enter"
              placeholder={disabled ? disabledReason : "Message Pi"}
              rows={1}
              className="max-h-48 min-h-14 w-full resize-none bg-transparent px-3 py-3 text-[15px] leading-6 text-[var(--bo-fg)] outline-none placeholder:text-[var(--bo-muted-2)] disabled:cursor-not-allowed"
            />
            <div className="flex min-h-10 items-center justify-between gap-2 px-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="hidden max-w-44 truncate px-2 text-[10px] text-[var(--bo-muted-2)] sm:block">
                  {modelLabel}
                </span>
                {readyForInput ? (
                  <span className="px-2 text-xs font-medium text-[var(--bo-muted)]">New turn</span>
                ) : (
                  <label>
                    <span className="sr-only">Message mode</span>
                    <select
                      disabled={disabled}
                      value={commandKind}
                      onChange={(event) => {
                        onCommandKindChange(event.target.value as "followUp" | "steer");
                      }}
                      className="min-h-10 border border-transparent bg-transparent px-2 text-xs font-medium text-[var(--bo-muted)] transition-[background-color,border-color,color] duration-150 outline-none hover:border-[color:var(--bo-border)] hover:bg-[var(--bo-panel)] hover:text-[var(--bo-fg)] focus:border-[color:var(--bo-accent)] disabled:cursor-not-allowed disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:text-[var(--bo-muted)]"
                    >
                      <option value="followUp">Follow up</option>
                      <option value="steer">Steer</option>
                    </select>
                  </label>
                )}
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
                  <button
                    type="button"
                    onClick={() => void onContinue()}
                    className={`inline-flex min-h-10 items-center px-3 text-xs font-medium text-[var(--bo-muted)] transition-[background-color,color,scale] duration-150 ease-out hover:bg-[var(--bo-panel)] hover:text-[var(--bo-fg)] ${tapScale}`}
                  >
                    Continue
                  </button>
                ) : null}
                {running ? (
                  <button
                    type="button"
                    onClick={() => void onStop()}
                    className={`inline-flex min-h-10 items-center border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] px-3 text-xs font-semibold text-[var(--bo-fg)] transition-[border-color,scale] duration-150 ease-out hover:border-[color:var(--bo-failed)] ${tapScale}`}
                  >
                    Stop
                  </button>
                ) : (
                  <ComposerPrimitive.Send
                    disabled={disabled}
                    className={`inline-flex min-h-10 items-center border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 text-xs font-semibold text-[var(--bo-accent-fg)] transition-[border-color,scale] duration-150 ease-out hover:border-[color:var(--bo-accent-strong)] disabled:cursor-not-allowed disabled:opacity-35 ${tapScale}`}
                  >
                    Send
                  </ComposerPrimitive.Send>
                )}
              </div>
            </div>
          </ComposerPrimitive.Root>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>

      {showScrollToLatest ? (
        <button
          type="button"
          onClick={scrollToLatest}
          className={`absolute bottom-[10.5rem] left-1/2 z-30 min-h-10 -translate-x-1/2 border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] px-4 text-[10px] font-semibold tracking-[0.08em] text-[var(--bo-fg)] uppercase shadow-[var(--bo-popover-shadow)] transition-[background-color,border-color,scale] duration-150 ease-out hover:border-[color:var(--bo-accent)] hover:bg-[var(--bo-panel-2)] ${tapScale}`}
        >
          Scroll to latest
        </button>
      ) : null}
    </ThreadPrimitive.Root>
  );
}
