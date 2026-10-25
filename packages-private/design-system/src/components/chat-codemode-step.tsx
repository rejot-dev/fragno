import { Fragment, useEffect, useState, type ReactNode } from "react";

import { cn } from "../cn";
import { ChatActivityItem, formatActivityDuration, type StepState } from "./chat-activity";
import { Icon, type IconName } from "./icon";

// A codemode run on the activity rail. What the program did leads: its calls are the view the step
// opens on, one line each, so a reader sees a skill load or a failed send without opening anything.
// The code, result, and logs are the other views, one tab away in the step's header.

/** What a call did, as far as a reader cares: discovery calls read as what they found. */
export type ChatCodemodeCallSubject =
  | { kind: "skill"; name: string }
  | { kind: "read"; path: string }
  | { kind: "list"; pattern: string }
  | { kind: "search"; keywords: readonly string[]; pattern: string }
  | {
      kind: "call";
      /** The tool as the program called it, such as "crm.contacts.list". */
      name: string;
      /** A scope other than the run's own, such as "org:acme"; null for the run's scope. */
      scope: string | null;
      /** A one-line summary of the input. */
      input: string;
    };

export type ChatCodemodeCall = {
  /** Stable across updates, so only a new call enters with an animation. */
  id: string;
  subject: ChatCodemodeCallSubject;
  /** When the call started, counted from the run's start. */
  offsetMs: number;
} & (
  | { status: "running" }
  | { status: "succeeded"; durationMs: number }
  | { status: "failed"; durationMs: number; error: string }
);

/** The calls a run's record lists, on the run's own timeline. */
export type ChatCodemodeCalls = {
  /** When the run started; each call's `offsetMs` counts from here. */
  startedAt: Date;
  /** Oldest first. */
  items: readonly ChatCodemodeCall[];
  /** Calls the run made that its record does not list. */
  unrecorded: number;
};

/** Something the run produced that a reader can open in its own tab, such as its code. */
export type ChatCodemodeView = { label: string; content: ReactNode };

// A long run shows its first calls; folding only a few more would hide less than the button costs.
const FOLDED_CALLS = 8;
const FOLD_AFTER = 12;

type CallLine = {
  icon: IconName;
  title: Record<ChatCodemodeCall["status"], string>;
  detail: string;
  /** Names the tool in code, as the program wrote it. */
  code: boolean;
};

function callLine(subject: ChatCodemodeCallSubject): CallLine {
  switch (subject.kind) {
    case "skill":
      return {
        icon: "book-open",
        title: { running: "Loading skill", succeeded: "Skill loaded", failed: "Skill not loaded" },
        detail: subject.name,
        code: false,
      };
    case "read":
      return {
        icon: "file-text",
        title: { running: "Reading", succeeded: "Read", failed: "Could not read" },
        detail: subject.path,
        code: false,
      };
    case "list":
      return {
        icon: "folder",
        title: { running: "Listing", succeeded: "Listed", failed: "Could not list" },
        detail: subject.pattern,
        code: false,
      };
    case "search":
      return {
        icon: "search",
        title: { running: "Searching", succeeded: "Searched", failed: "Could not search" },
        detail: `${subject.keywords.map((keyword) => JSON.stringify(keyword)).join(" ")} in ${subject.pattern}`,
        code: false,
      };
    case "call":
      return {
        icon: "corner-down-right",
        title: { running: subject.name, succeeded: subject.name, failed: subject.name },
        detail: subject.input,
        code: true,
      };
  }
  throw new Error("Unsupported codemode call.", { cause: subject satisfies never });
}

/** What a running call is doing, for a live headline, such as "Reading /workspace/notes.md". */
export function codemodeCallHeadline(subject: ChatCodemodeCallSubject) {
  switch (subject.kind) {
    case "skill":
      return `Loading the ${subject.name} skill`;
    case "call":
      return `Calling ${subject.name}`;
    case "read":
    case "list":
    case "search": {
      const { title, detail } = callLine(subject);
      return `${title.running} ${detail}`;
    }
  }
  throw new Error("Unsupported codemode call.", { cause: subject satisfies never });
}

/**
 * The call's span on the run's time axis, so time the program spent between calls, such as waiting,
 * shows as empty space and parallel calls stack. A running call reaches to now and pulses.
 */
function CallBar({ call, spanMs }: { call: ChatCodemodeCall; spanMs: number }) {
  const end = call.status === "running" ? spanMs : call.offsetMs + call.durationMs;
  return (
    <span className="relative hidden h-1.5 w-24 flex-none bg-[var(--bo-panel-2)] sm:block">
      <span
        className={cn(
          "absolute inset-y-0 min-w-[2px] transition-[left,width] duration-100 ease-linear",
          call.status === "running"
            ? "animate-pulse bg-[var(--bo-accent)]"
            : call.status === "failed"
              ? "bg-[var(--bo-failed)]"
              : "bg-[var(--bo-muted-2)]",
        )}
        style={{
          left: `${(call.offsetMs / spanMs) * 100}%`,
          width: `${(Math.max(end - call.offsetMs, 0) / spanMs) * 100}%`,
        }}
      />
    </span>
  );
}

function CallRow({ call, spanMs }: { call: ChatCodemodeCall; spanMs: number }) {
  const { icon, title, detail, code } = callLine(call.subject);
  const running = call.status === "running";
  const failed = call.status === "failed";
  const skill = call.subject.kind === "skill";
  return (
    <li className="bo-chat-enter min-w-0">
      <div className="flex min-h-6 min-w-0 items-center gap-2 text-[11px]">
        <Icon
          name={failed ? "x" : icon}
          strokeWidth={failed ? 2.5 : 2}
          className={cn(
            "size-3 flex-none",
            running
              ? "animate-pulse text-[var(--bo-accent)]"
              : failed
                ? "text-[var(--bo-failed)]"
                : skill
                  ? "text-[var(--bo-live)]"
                  : "text-[var(--bo-muted-2)]",
          )}
        />
        <span
          className={cn(
            "shrink-0",
            code ? "font-mono" : null,
            failed
              ? "text-[var(--bo-failed)]"
              : skill
                ? "text-[var(--bo-live)]"
                : "text-[var(--bo-fg)]",
          )}
        >
          {running ? <span className="bo-shimmer-text">{title.running}</span> : title[call.status]}
        </span>
        {call.subject.kind === "call" && call.subject.scope !== null ? (
          <span className="shrink-0 border border-[color:var(--bo-border)] px-1 font-mono text-[10px] text-[var(--bo-muted)]">
            {call.subject.scope}
          </span>
        ) : null}
        <code
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--bo-muted-2)]",
            // A tool's input is a hint; a path or skill name is the point of its line.
            code ? "hidden sm:block" : null,
          )}
        >
          {detail}
        </code>
        <CallBar call={call} spanMs={spanMs} />
        <span className="min-w-10 flex-none text-right text-[10px] text-[var(--bo-muted-2)] tabular-nums">
          {running ? "" : formatActivityDuration(call.durationMs)}
        </span>
      </div>
      {failed ? (
        <p className="mb-1 ml-5 line-clamp-2 text-[11px] leading-4 text-pretty text-[var(--bo-failed)]">
          {call.error}
        </p>
      ) : null}
    </li>
  );
}

/** Marks where a folded list leaves out calls between the ones it shows. */
function SkippedCalls({ count }: { count: number }) {
  return (
    <li className="flex min-h-6 items-center pl-5 text-[10px] text-[var(--bo-muted-2)] tabular-nums">
      ⋯ {count} {count === 1 ? "call" : "calls"}
    </li>
  );
}

// Fast enough that bars glide as a live run's axis grows, and cheap for a list this size.
const LIVE_TICK_MS = 100;

/** The current time, kept fresh while `live`; a settled run does no timer work. */
function useNow(live: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) {
      return undefined;
    }
    const interval = setInterval(() => {
      setNow(Date.now());
    }, LIVE_TICK_MS);
    return () => {
      clearInterval(interval);
    };
  }, [live]);
  return now;
}

/**
 * The time axis every bar shares. A settled run's axis is its duration; a live run's grows with
 * the clock, so earlier calls drift left while the program works between calls. The calls the
 * server already reported bound it from below, in case this clock runs behind the server's.
 */
function useCallsSpanMs(
  { startedAt, items }: ChatCodemodeCalls,
  live: boolean,
  durationMs: number | null,
) {
  const now = useNow(live);
  const knownMs = Math.max(
    durationMs ?? 0,
    ...items.map((call) => call.offsetMs + (call.status === "running" ? 0 : call.durationMs)),
  );
  return Math.max(live ? Math.max(knownMs, now - startedAt.getTime()) : knownMs, 1);
}

function CallList({
  calls,
  live,
  durationMs,
}: {
  calls: ChatCodemodeCalls;
  live: boolean;
  durationMs: number | null;
}) {
  const spanMs = useCallsSpanMs(calls, live, durationMs);
  const { items, unrecorded } = calls;
  const [expanded, setExpanded] = useState(false);
  const folded = !expanded && items.length > FOLD_AFTER;
  // A folded list still shows every failure, since failures are what a reader looks for.
  const shown = folded
    ? items.filter((call, index) => index < FOLDED_CALLS || call.status === "failed")
    : items;
  return (
    <>
      <ol>
        {shown.map((call, index) => {
          const skipped =
            items.indexOf(call) - (index === 0 ? 0 : items.indexOf(shown[index - 1]) + 1);
          return (
            <Fragment key={call.id}>
              {skipped > 0 ? <SkippedCalls count={skipped} /> : null}
              <CallRow call={call} spanMs={spanMs} />
            </Fragment>
          );
        })}
      </ol>
      {folded || unrecorded > 0 ? (
        <div className="flex min-h-6 items-center gap-3 pl-5 text-[10px] text-[var(--bo-muted-2)]">
          {folded ? (
            <button
              type="button"
              className="font-medium text-[var(--bo-accent-fg)] hover:underline"
              onClick={() => {
                setExpanded(true);
              }}
            >
              Show all {items.length}
            </button>
          ) : null}
          {unrecorded > 0 ? <span>{unrecorded} more not recorded</span> : null}
        </div>
      ) : null}
    </>
  );
}

function ViewToggle({
  label,
  pressed,
  onClick,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "h-6 px-1.5 text-[10px] font-medium transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30",
        pressed
          ? "bg-[var(--bo-panel-2)] text-[var(--bo-fg)]"
          : "text-[var(--bo-muted-2)] hover:text-[var(--bo-fg)]",
      )}
    >
      {label}
    </button>
  );
}

const CALLS_VIEW = "Calls";

/**
 * A codemode run on the activity rail: a header naming the run, with tabs for its calls and what it
 * produced, and the chosen tab beneath. It shows its calls until the reader picks another tab;
 * picking the open tab again folds the run to its header.
 */
export function ChatCodemodeStep({
  state,
  detail,
  calls,
  durationMs,
  views,
  actions,
}: {
  state: StepState;
  /** A line beside the title, such as "writing code" before the program runs. */
  detail: string | null;
  /** Null until the run reports its first calls. */
  calls: ChatCodemodeCalls | null;
  durationMs: number | null;
  /** The run's other tabs, such as its code, result, and logs. */
  views: readonly ChatCodemodeView[];
  /** Controls beside the header, such as ChatArtifactToggles. */
  actions: ReactNode | null;
}) {
  // Null until the reader picks a tab, so a live run shows its calls as soon as the first arrives.
  const [picked, setPicked] = useState<{ label: string | null } | null>(null);
  const tabs: readonly ChatCodemodeView[] =
    calls !== null && (calls.items.length > 0 || calls.unrecorded > 0)
      ? [
          {
            label: CALLS_VIEW,
            content: <CallList calls={calls} live={state === "running"} durationMs={durationMs} />,
          },
          ...views,
        ]
      : views;
  const openLabel = picked === null ? CALLS_VIEW : picked.label;
  const shownTab = tabs.find((tab) => tab.label === openLabel) ?? null;
  return (
    <ChatActivityItem icon={state === "failed" ? "alert-triangle" : "code"} state={state}>
      <div className="min-w-0 pb-1">
        <div className="flex min-h-9 min-w-0 items-center gap-2 text-xs">
          <span
            className={cn(
              "shrink-0",
              state === "failed" ? "text-[var(--bo-failed)]" : "text-[var(--bo-fg)]",
            )}
          >
            {state === "running" ? <span className="bo-shimmer-text">codemode</span> : "codemode"}
          </span>
          {detail === null ? null : (
            <code className="min-w-0 truncate font-mono text-[10px] text-[var(--bo-muted-2)]">
              {detail}
            </code>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1 pl-2">
            {durationMs === null ? null : (
              <span className="pr-1 text-[10px] text-[var(--bo-muted-2)] tabular-nums">
                {formatActivityDuration(durationMs)}
              </span>
            )}
            {tabs.map((tab) => (
              <ViewToggle
                key={tab.label}
                label={tab.label}
                pressed={tab === shownTab}
                onClick={() => {
                  setPicked({ label: tab === shownTab ? null : tab.label });
                }}
              />
            ))}
          </span>
          {actions}
        </div>
        {shownTab === null ? null : (
          <div className={cn(shownTab.label === CALLS_VIEW ? null : "pt-1 pb-2")}>
            {shownTab.content}
          </div>
        )}
      </div>
    </ChatActivityItem>
  );
}
