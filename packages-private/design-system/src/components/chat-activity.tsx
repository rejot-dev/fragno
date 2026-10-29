import { Collapsible } from "@base-ui/react/collapsible";
import { useEffect, useState, type ReactNode } from "react";

import { cn } from "../cn";
import { Icon, type IconName } from "./icon";

// An agent's work — its thoughts and tool calls — gathered into a card between what it says. The
// card stays open while the agent works, so steps appear as they happen, and folds into a one-line
// summary once the agent moves on.

/** Progress pulses while work runs; the others name what kind of activity settled. */
export type ActivityMarker = "progress" | "live" | "failed" | "accent" | "notification";

const MARKER_CLASS_NAMES: Record<ActivityMarker, string> = {
  progress: "animate-pulse bg-[var(--bo-accent)]",
  live: "bg-[var(--bo-live)]",
  failed: "bg-[var(--bo-failed)]",
  accent: "bg-[var(--bo-accent)]",
  notification: "bg-amber-500",
};

export function ActivityMarkerDot({ marker }: { marker: ActivityMarker }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-1.5 flex-none rounded-full", MARKER_CLASS_NAMES[marker])}
    />
  );
}

/** Animates a collapsible panel's height between closed and its content's height. */
export const collapsiblePanelClassName =
  "h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-200 ease-[cubic-bezier(0.2,0,0,1)] data-[ending-style]:h-0 data-[starting-style]:h-0";

/** A chevron that points right while its section is closed and down once it opens. */
export function DisclosureChevron({ open }: { open: boolean }) {
  return (
    <Icon
      name="chevron-down"
      className={cn(
        "size-3.5 flex-none text-[var(--bo-muted-2)] transition-transform duration-200 ease-[cubic-bezier(0.2,0,0,1)]",
        open ? "rotate-0" : "-rotate-90",
      )}
    />
  );
}

/** Milliseconds under a second, tenths under ten, whole seconds under a minute, then minutes. */
export function formatActivityDuration(milliseconds: number) {
  if (milliseconds < 1_000) {
    return `${Math.max(0, Math.round(milliseconds))}ms`;
  }
  if (milliseconds < 10_000) {
    return `${(milliseconds / 1000).toFixed(1)}s`;
  }
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Counts up from `since` once a second. */
function ElapsedTime({ since }: { since: Date }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(interval);
    };
  }, []);
  const seconds = Math.max(0, Math.floor((now - since.getTime()) / 1000));
  return (
    <span className="text-[10px] text-[var(--bo-muted-2)] tabular-nums">
      {seconds < 60
        ? `${seconds}s`
        : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`}
    </span>
  );
}

/**
 * The newest headline, swapped in with a short rise each time it changes, with a sheen passing
 * over it to show the agent is still at it.
 */
function LiveHeadline({ children }: { children: string }) {
  return (
    <span className="relative min-w-0 flex-1 overflow-hidden" aria-live="polite">
      <span key={children} className="bo-headline-enter block truncate">
        <span className="bo-shimmer-text">{children}</span>
      </span>
    </span>
  );
}

export type ChatActivityStatus =
  | {
      kind: "running";
      /** What the agent is doing right now, such as its newest thought's headline. */
      headline: string;
      startedAt: Date;
    }
  | {
      kind: "settled";
      outcome: "done" | "stopped" | "failed";
      /** Null when the turn's timing was not recorded. */
      durationMs: number | null;
      /** A count of what happened, such as "4 tools · 3 thoughts". */
      note: string;
      /** How many tool calls failed along the way; shown as a warning in the summary. */
      failedSteps: number;
    };

const OUTCOME_LABELS: Record<"done" | "stopped" | "failed", [string, string]> = {
  done: ["Worked", "Worked for"],
  stopped: ["Stopped", "Stopped after"],
  failed: ["Failed", "Failed after"],
};

function settledTitle(outcome: "done" | "stopped" | "failed", durationMs: number | null) {
  const [bare, timed] = OUTCOME_LABELS[outcome];
  return durationMs === null ? bare : `${timed} ${formatActivityDuration(durationMs)}`;
}

/**
 * One card for a stretch of the agent's work. While it runs, the header shows the agent's newest
 * headline and the card stays open; once it settles it folds to a summary unless the reader
 * opened or closed it themselves.
 */
export function ChatActivity({
  status,
  artifacts,
  children,
}: {
  status: ChatActivityStatus;
  /** Always-visible controls for what the turn produced, such as side panel views. */
  artifacts: ReactNode | null;
  /** ChatActivityStep rows, oldest first. */
  children: ReactNode;
}) {
  const running = status.kind === "running";
  const [readerOpen, setReaderOpen] = useState<boolean | null>(null);
  const open = readerOpen ?? running;

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setReaderOpen}
      className="bo-chat-enter min-w-0 rounded-[4px] border border-[color:var(--bo-selected-border)] bg-[var(--bo-selected-bg)] shadow-[var(--bo-selected-shadow)] transition-[border-color] duration-200 data-[open]:border-[color:var(--bo-border-strong)]"
    >
      <div className="flex min-w-0 items-center">
        <Collapsible.Trigger className="group/activity flex min-h-11 min-w-0 flex-1 items-center gap-3 px-3 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:ring-inset">
          {running ? (
            <>
              <ActivityMarkerDot marker="progress" />
              <LiveHeadline>{status.headline}</LiveHeadline>
              <ElapsedTime since={status.startedAt} />
            </>
          ) : (
            <>
              <ActivityMarkerDot
                marker={
                  status.outcome === "failed"
                    ? "failed"
                    : status.outcome === "stopped"
                      ? "accent"
                      : "live"
                }
              />
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="shrink-0 font-medium text-[var(--bo-fg)]">
                  {settledTitle(status.outcome, status.durationMs)}
                </span>
                <span className="truncate text-[10px] text-[var(--bo-muted-2)]">{status.note}</span>
                {status.failedSteps === 0 ? null : (
                  <span className="shrink-0 text-[10px] font-medium text-[var(--bo-failed)]">
                    {status.failedSteps} failed
                  </span>
                )}
              </span>
            </>
          )}
          <span className="text-[var(--bo-muted-2)] transition-colors duration-150 group-hover/activity:text-[var(--bo-fg)]">
            <DisclosureChevron open={open} />
          </span>
        </Collapsible.Trigger>
        {artifacts === null ? null : (
          <div className="flex shrink-0 items-center gap-1 border-l border-[color:var(--bo-border)] px-2">
            {artifacts}
          </div>
        )}
      </div>
      <Collapsible.Panel className={collapsiblePanelClassName}>
        <ol className="border-t border-[color:var(--bo-border)] px-3 py-2">{children}</ol>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/**
 * Shows or hides something the agent produced, such as a generated interface, in a side panel. The
 * label hides on narrow screens and when `labelled` is false, as it is beside a single step.
 */
export function ChatArtifactToggle({
  icon,
  label,
  labelled,
  pressed,
  onClick,
}: {
  icon: IconName;
  /** What the panel shows, such as "Interface"; the button names the action from it. */
  label: string;
  labelled: boolean;
  pressed: boolean;
  onClick: () => void;
}) {
  const actionLabel = `${pressed ? "Hide" : "Show"} ${label} in side panel`;
  return (
    <button
      type="button"
      aria-label={actionLabel}
      aria-pressed={pressed}
      title={actionLabel}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-1.5 border px-1.5 text-[10px] font-medium transition-[scale,background-color,border-color,color] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96]",
        pressed
          ? "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]"
          : "border-[color:var(--bo-border)] text-[var(--bo-muted)] hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]",
      )}
    >
      <Icon name={icon} className="size-3.5" />
      {labelled ? <span className="hidden sm:inline">{label}</span> : null}
    </button>
  );
}

// The rail runs behind the markers, from the first step's marker to the last step's.
const STEP_CLASS_NAME =
  "bo-chat-enter relative grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2 before:absolute before:top-0 before:bottom-0 before:left-[0.625rem] before:w-px before:bg-[var(--bo-border-strong)] first:before:top-[1.125rem] last:before:bottom-auto last:before:h-[1.125rem] only:before:hidden";

function StepMarker({ icon, state }: { icon: IconName | null; state: StepState }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative z-10 mt-2 flex size-5 items-center justify-center self-start bg-[var(--bo-panel)]",
        state === "running"
          ? "text-[var(--bo-accent)]"
          : state === "failed"
            ? "text-[var(--bo-failed)]"
            : "text-[var(--bo-muted-2)]",
      )}
    >
      {icon === null ? (
        <span
          className={cn(
            "size-1.5 rounded-full",
            state === "running"
              ? "animate-pulse bg-[var(--bo-accent)]"
              : state === "failed"
                ? "bg-[var(--bo-failed)]"
                : "bg-[var(--bo-muted-2)]",
          )}
        />
      ) : (
        <Icon
          name={icon}
          className={cn("size-3.5", state === "running" ? "animate-pulse" : null)}
        />
      )}
    </span>
  );
}

export type StepState = "running" | "done" | "failed";

/** One entry on the activity rail: its marker, then whatever the entry shows beside it. */
export function ChatActivityItem({
  icon,
  state,
  children,
}: {
  /** Null marks the entry with a dot, as thoughts are. */
  icon: IconName | null;
  state: StepState;
  children: ReactNode;
}) {
  return (
    <li className={STEP_CLASS_NAME}>
      <StepMarker icon={icon} state={state} />
      {children}
    </li>
  );
}

/**
 * One thing the agent did: a thought, under its headline, or a tool call. The body opens on
 * demand and mounts only while open, so costly content waits for the reader.
 */
export function ChatActivityStep({
  icon,
  state,
  title,
  detail,
  durationMs,
  actions,
  children,
}: {
  /** Null marks the step with a dot, as thoughts are. */
  icon: IconName | null;
  state: StepState;
  title: string;
  /** A monospace identifier beside the title, such as a path; hidden on narrow screens. */
  detail: string | null;
  durationMs: number | null;
  /** Controls beside the row, such as ChatArtifactToggles. */
  actions: ReactNode | null;
  /** Null when there is nothing more to show. */
  children: ReactNode | null;
}) {
  const [open, setOpen] = useState(false);
  const row = (
    <>
      <span
        className={cn(
          "min-w-0 truncate",
          state === "failed" ? "text-[var(--bo-failed)]" : "text-[var(--bo-fg)]",
        )}
      >
        {state === "running" ? <span className="bo-shimmer-text">{title}</span> : title}
      </span>
      {detail === null ? null : (
        <code className="hidden min-w-0 truncate font-mono text-[10px] text-[var(--bo-muted-2)] sm:block">
          {detail}
        </code>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
        {durationMs === null ? null : (
          <span className="text-[10px] text-[var(--bo-muted-2)] tabular-nums">
            {formatActivityDuration(durationMs)}
          </span>
        )}
        {children === null ? null : <DisclosureChevron open={open} />}
      </span>
    </>
  );

  return (
    <ChatActivityItem icon={icon} state={state}>
      {children === null ? (
        <div className="flex min-h-9 min-w-0 items-center gap-2 text-xs">
          {row}
          {actions}
        </div>
      ) : (
        <Collapsible.Root open={open} onOpenChange={setOpen} className="min-w-0">
          <div className="flex min-w-0 items-center gap-1">
            <Collapsible.Trigger className="-ml-1.5 flex min-h-9 min-w-0 flex-1 items-center gap-2 px-1.5 text-left text-xs transition-colors duration-150 outline-none hover:bg-[var(--bo-panel-2)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:ring-inset">
              {row}
            </Collapsible.Trigger>
            {actions}
          </div>
          <Collapsible.Panel className={collapsiblePanelClassName}>
            <div className="space-y-3 pt-1 pb-3">{children}</div>
          </Collapsible.Panel>
        </Collapsible.Root>
      )}
    </ChatActivityItem>
  );
}
