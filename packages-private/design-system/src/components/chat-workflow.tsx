import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";

import { cn } from "../cn";
import { Button } from "./button";
import { ActivityMarkerDot } from "./chat-activity";
import { Icon } from "./icon";
import { BackofficeStatusLight } from "./status-light";
import type { BackofficeStatusTone } from "./status-tone";
import { UnderlineToggleButton } from "./underline-tabs";

// A workflow the agent started, shown in the turn that started it. The card holds the whole run:
// every interface its steps produced, such as a form it waits on, and the output it ended with.
// The reader acts on the run and reads its result here; the rest of the thread only points at it.

export type ChatWorkflowStatus =
  | { kind: "synchronizing" }
  | {
      kind: "running";
      /** The step running now; null when the run has not recorded which. */
      step: string | null;
    }
  | {
      kind: "waiting-for-input";
      /** The step whose interface the reader is asked to complete. */
      step: string;
    }
  | {
      kind: "waiting";
      /** The step waiting on something other than the reader, such as a timer or an event. */
      step: string | null;
    }
  | { kind: "complete" }
  | { kind: "stopped" }
  | {
      kind: "failed";
      /** The step that failed; null when the run failed outside one. */
      step: string | null;
      error: string;
    }
  | { kind: "synchronization-failed"; error: string };

const STATUS_LIGHTS: Record<ChatWorkflowStatus["kind"], [BackofficeStatusTone, string]> = {
  synchronizing: ["muted", "Synchronizing"],
  running: ["info", "Running"],
  "waiting-for-input": ["waiting", "Needs your input"],
  waiting: ["muted", "Waiting"],
  complete: ["live", "Complete"],
  stopped: ["muted", "Stopped"],
  failed: ["failed", "Failed"],
  "synchronization-failed": ["failed", "Out of sync"],
};

export type ChatWorkflowElement = {
  /** Stable across updates, so only a new element enters with an animation. */
  id: string;
  /** Names it in the card's strip, such as the step that produced it. */
  label: string;
  /**
   * A step's interface can ask the reader for input, and locks once it is no longer the one the
   * run waits on. The run's output only reports, so it never locks.
   */
  kind: "step" | "output";
  content: ReactNode;
};

/** What the run is doing after its newest element, shown in that element's place. */
function pendingWork(status: ChatWorkflowStatus): { label: string; active: boolean } | null {
  switch (status.kind) {
    case "synchronizing":
      return { label: "Loading the run", active: true };
    case "running":
      return { label: status.step ?? "Working", active: true };
    case "waiting":
      return {
        label: status.step === null ? "Waiting" : `Waiting · ${status.step}`,
        active: false,
      };
    case "waiting-for-input":
    case "complete":
    case "stopped":
    case "failed":
    case "synchronization-failed":
      return null;
  }
  throw new Error("Unsupported workflow status.", { cause: status satisfies never });
}

function statusError(status: ChatWorkflowStatus) {
  switch (status.kind) {
    case "failed":
      return status.step === null ? status.error : `${status.step}: ${status.error}`;
    case "synchronization-failed":
      return status.error;
    case "synchronizing":
    case "running":
    case "waiting-for-input":
    case "waiting":
    case "complete":
    case "stopped":
      return null;
  }
  throw new Error("Unsupported workflow status.", { cause: status satisfies never });
}

type StopState =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "stopping" }
  | { kind: "failed"; error: string };

/**
 * A workflow run in the conversation: its name and status over one element at a time. It shows
 * the newest element, or what the run is working on after it, and a strip jumps between them all.
 * Earlier interfaces stay locked, showing what the reader entered. The card stands out while the
 * run waits for the reader. Spreads its props so the reader can be brought to it, such as from a
 * ChatWorkflowInputRequest.
 */
export function ChatWorkflow({
  name,
  status,
  elements,
  selectedId,
  onSelect,
  onStop,
  ...props
}: Omit<ComponentProps<"section">, "className" | "children" | "onSelect"> & {
  name: string;
  status: ChatWorkflowStatus;
  /** Oldest first. */
  elements: readonly ChatWorkflowElement[];
  /** The element the reader picked; null follows the run, showing what it is on now. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Ends the run; null when it cannot be stopped, such as once it ended. */
  onStop: (() => Promise<void>) | null;
}) {
  const [tone, label] = STATUS_LIGHTS[status.kind];
  const error = statusError(status);
  const needsInput = status.kind === "waiting-for-input";
  const pending = pendingWork(status);
  const newestIndex = elements.length - 1;
  const selectedIndex = elements.findIndex((element) => element.id === selectedId);
  // The pending work, when there is any, follows the newest element in the strip.
  const entryCount = elements.length + (pending === null ? 0 : 1);
  const shownIndex = selectedIndex !== -1 ? selectedIndex : entryCount - 1;
  const shown = shownIndex >= 0 && shownIndex < elements.length ? elements[shownIndex] : null;

  const select = (index: number) => {
    onSelect(index === entryCount - 1 ? null : (elements[index]?.id ?? null));
  };

  return (
    <section
      aria-label={`${name} workflow`}
      tabIndex={-1}
      {...props}
      // Scrolled into view clear of the composer that floats over the thread's bottom.
      className={cn(
        "bo-chat-enter min-w-0 scroll-mt-6 scroll-mb-56 overflow-hidden rounded-[4px] border bg-[var(--bo-panel)] transition-[border-color,box-shadow] duration-200 outline-none",
        needsInput
          ? "border-[color:var(--bo-waiting)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--bo-waiting)_14%,transparent)]"
          : "border-[color:var(--bo-border-strong)]",
      )}
    >
      <header className="flex min-h-11 min-w-0 items-center gap-3 py-1.5 pr-1.5 pl-3">
        <Icon name="share-2" className="size-3.5 flex-none text-[var(--bo-muted-2)]" />
        <p className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--bo-fg)]">{name}</p>
        <BackofficeStatusLight tone={tone} role="status">
          {label}
        </BackofficeStatusLight>
        {onStop === null ? null : <StopControl onStop={onStop} />}
      </header>
      {entryCount > 1 ? (
        <nav
          aria-label={`${name} steps`}
          className="flex min-w-0 items-center gap-1 border-t border-[color:var(--bo-border)] pr-1.5 pl-1"
        >
          <StepStrip shownIndex={shownIndex}>
            {elements.map((element, index) => (
              <UnderlineToggleButton
                key={element.id}
                pressed={index === shownIndex}
                onClick={() => {
                  select(index);
                }}
                className="min-h-9 text-xs"
              >
                <span className="text-[var(--bo-muted-2)] tabular-nums">{index + 1}</span>
                <span className="max-w-48 truncate">{element.label}</span>
                {needsInput && index === newestIndex ? (
                  <ActivityMarkerDot marker="notification" />
                ) : null}
              </UnderlineToggleButton>
            ))}
            {pending === null ? null : (
              <UnderlineToggleButton
                pressed={shownIndex === entryCount - 1}
                onClick={() => {
                  onSelect(null);
                }}
                className="min-h-9 text-xs"
              >
                <span className="max-w-48 truncate">
                  {pending.active ? (
                    <span className="bo-shimmer-text">{pending.label}</span>
                  ) : (
                    pending.label
                  )}
                </span>
              </UnderlineToggleButton>
            )}
          </StepStrip>
          <span className="px-1 text-[10px] text-[var(--bo-muted-2)] tabular-nums">
            {shownIndex + 1}/{entryCount}
          </span>
          <StepButton
            icon="chevron-left"
            label="Previous step"
            disabled={shownIndex === 0}
            onClick={() => {
              select(shownIndex - 1);
            }}
          />
          <StepButton
            icon="chevron-right"
            label="Next step"
            disabled={shownIndex === entryCount - 1}
            onClick={() => {
              select(shownIndex + 1);
            }}
          />
        </nav>
      ) : null}
      {shown !== null ? (
        <div key={shown.id} className="bo-chat-enter border-t border-[color:var(--bo-border)] p-3">
          {shown.kind === "step" && !(needsInput && shownIndex === newestIndex) ? (
            // A disabled fieldset locks every control inside, whatever rendered them.
            <fieldset disabled className="m-0 min-w-0 border-0 p-0">
              {shown.content}
            </fieldset>
          ) : (
            shown.content
          )}
        </div>
      ) : pending !== null ? (
        <p
          aria-live="polite"
          className="flex min-h-20 items-center border-t border-[color:var(--bo-border)] px-3 text-xs text-[var(--bo-muted)]"
        >
          {pending.active ? (
            <span key={pending.label} className="bo-headline-enter">
              <span className="bo-shimmer-text">{pending.label}</span>
            </span>
          ) : (
            pending.label
          )}
        </p>
      ) : null}
      {error === null ? null : (
        <p
          role="alert"
          className="border-t border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] px-3 py-2 text-xs leading-5 [overflow-wrap:anywhere] text-[var(--bo-failed)]"
        >
          {error}
        </p>
      )}
    </section>
  );
}

/** Scrolls itself so the shown step's tab stays in view as the run adds steps. */
function StepStrip({ shownIndex, children }: { shownIndex: number; children: ReactNode }) {
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const tab = strip.current?.children[shownIndex];
    if (!(tab instanceof HTMLElement) || strip.current === null) {
      return;
    }
    // Scrolls only the strip; scrollIntoView would also scroll the thread to the card.
    const { scrollLeft, clientWidth } = strip.current;
    if (tab.offsetLeft < scrollLeft) {
      strip.current.scrollLeft = tab.offsetLeft;
    } else if (tab.offsetLeft + tab.offsetWidth > scrollLeft + clientWidth) {
      strip.current.scrollLeft = tab.offsetLeft + tab.offsetWidth - clientWidth;
    }
  }, [shownIndex]);
  return (
    <div
      ref={strip}
      className="relative flex min-w-0 flex-1 [scrollbar-width:none] gap-1 overflow-x-auto"
    >
      {children}
    </div>
  );
}

function StepButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: "chevron-left" | "chevron-right";
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="min-h-8 px-1.5"
    >
      <Icon name={icon} className="size-3.5" />
    </Button>
  );
}

/** Stopping ends the run for good, so it asks once more in place. */
function StopControl({ onStop }: { onStop: () => Promise<void> }) {
  const [state, setState] = useState<StopState>({ kind: "idle" });
  const stop = () => {
    setState({ kind: "stopping" });
    onStop().then(
      () => {
        setState({ kind: "idle" });
      },
      (cause: unknown) => {
        setState({
          kind: "failed",
          error: cause instanceof Error ? cause.message : "Could not stop the run.",
        });
      },
    );
  };

  switch (state.kind) {
    case "idle":
      return (
        <Button
          variant="ghost"
          onClick={() => {
            setState({ kind: "confirming" });
          }}
          className="min-h-8 px-2 text-xs text-[var(--bo-muted)]"
        >
          Stop
        </Button>
      );
    case "confirming":
    case "stopping":
      return (
        <span className="flex items-center gap-1">
          <Button
            variant="danger"
            disabled={state.kind === "stopping"}
            onClick={stop}
            className="min-h-8 px-2 text-xs"
          >
            {state.kind === "stopping" ? "Stopping…" : "Stop the run"}
          </Button>
          <Button
            variant="ghost"
            disabled={state.kind === "stopping"}
            onClick={() => {
              setState({ kind: "idle" });
            }}
            className="min-h-8 px-2 text-xs"
          >
            Keep
          </Button>
        </span>
      );
    case "failed":
      return (
        <span className="flex min-w-0 items-center gap-1">
          <span role="alert" className="truncate text-[10px] text-[var(--bo-failed)]">
            {state.error}
          </span>
          <Button variant="ghost" onClick={stop} className="min-h-8 px-2 text-xs">
            Retry
          </Button>
        </span>
      );
  }
  throw new Error("Unsupported stop state.", { cause: state satisfies never });
}

export type ChatWorkflowInputRequestEntry = {
  /** The run's id, passed back to onShow. */
  id: string;
  name: string;
  /** The step whose interface waits for the reader. */
  step: string;
};

/**
 * Above the composer while workflows wait for the reader out of view. It names the first; once the
 * reader goes to it, the next takes its place. Place it inside the ChatViewportFooter.
 */
export function ChatWorkflowInputRequest({
  requests,
  onShow,
}: {
  /** In thread order. */
  requests: readonly ChatWorkflowInputRequestEntry[];
  /** Brings the reader to the run's card, showing the interface it waits on. */
  onShow: (id: string) => void;
}) {
  const [first] = requests;
  if (first === undefined) {
    return null;
  }
  return (
    <div className="bo-chat-enter mb-2 flex min-h-11 min-w-0 items-center gap-3 rounded-[4px] border border-[color:var(--bo-waiting)] bg-[var(--bo-panel)] py-1.5 pr-1.5 pl-3 text-xs shadow-[var(--bo-popover-shadow)]">
      <ActivityMarkerDot marker="notification" />
      <p className="min-w-0 flex-1 truncate">
        <span className="font-medium text-[var(--bo-fg)]">{first.name}</span>
        <span className="text-[var(--bo-muted-2)]"> needs your input · {first.step}</span>
      </p>
      {requests.length > 1 ? (
        <span className="flex-none text-[var(--bo-muted-2)] tabular-nums">
          +{requests.length - 1} more
        </span>
      ) : null}
      <Button
        variant="secondary"
        onClick={() => {
          onShow(first.id);
        }}
        className="min-h-8 px-2.5 text-xs"
      >
        Show
      </Button>
    </div>
  );
}
