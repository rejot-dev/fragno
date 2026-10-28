import { Collapsible } from "@base-ui/react/collapsible";
import { useEffect, useState, type ComponentProps, type ReactNode } from "react";

import { cn } from "../cn";
import { Button } from "./button";
import {
  ActivityMarkerDot,
  DisclosureChevron,
  collapsiblePanelClassName,
  formatActivityDuration,
} from "./chat-activity";
import { Icon } from "./icon";

// Subagents shown in the thread rather than beside it. Those an agent starts sit in the turn that
// started them, as one card for the batch; those someone else starts sit in the thread where they
// were asked. Each row reads as where its subagent stands, and opens its transcript in place.

export type ChatSubagentRunStatus =
  | { kind: "queued" }
  | {
      kind: "running";
      /** What it is doing right now, such as its newest thought's headline. */
      headline: string;
      startedAt: Date;
    }
  | {
      kind: "completed";
      durationMs: number | null;
      /** Its answer as plain text; the row shows its start. */
      answer: string;
    }
  /** Stopped with its agent before it answered. */
  | { kind: "stopped" }
  | { kind: "failed"; reason: string };

export type ChatSubagentRun = {
  /** Stable across updates, such as the request ID that started it. */
  id: string;
  /** What it was asked to do. */
  task: string;
  status: ChatSubagentRunStatus;
  /** Its conversation, mounted only while the row is open. */
  transcript: ReactNode;
};

type Kind = ChatSubagentRunStatus["kind"];

// Fixed order, so the progress bar fills from the left as subagents settle.
const KIND_ORDER: readonly Kind[] = ["completed", "failed", "stopped", "running", "queued"];

const KIND_LABELS: Record<Kind, string> = {
  completed: "done",
  failed: "failed",
  stopped: "stopped",
  running: "running",
  queued: "waiting",
};

const SEGMENT_CLASS_NAMES: Record<Kind, string> = {
  completed: "bg-[var(--bo-live)]",
  failed: "bg-[var(--bo-failed)]",
  stopped: "bg-[var(--bo-muted-2)]",
  running: "bg-[var(--bo-accent)]",
  queued: "bg-[var(--bo-border-strong)]",
};

function countKinds(statuses: readonly ChatSubagentRunStatus[]) {
  const counts: Record<Kind, number> = {
    completed: 0,
    failed: 0,
    stopped: 0,
    running: 0,
    queued: 0,
  };
  for (const { kind } of statuses) {
    counts[kind] += 1;
  }
  return counts;
}

/** "2 running · 1 waiting · 3 done", in the bar's order, leaving out kinds none are in. */
function countSummary(counts: Record<Kind, number>) {
  return KIND_ORDER.filter((kind) => counts[kind] > 0)
    .map((kind) => `${counts[kind]} ${KIND_LABELS[kind]}`)
    .join(" · ");
}

/** One segment per subagent, settled ones first, so a batch's progress reads at a glance. */
function SubagentProgress({ statuses }: { statuses: readonly ChatSubagentRunStatus[] }) {
  const counts = countKinds(statuses);
  const sorted = KIND_ORDER.flatMap((kind) => Array.from({ length: counts[kind] }, () => kind));
  return (
    <span
      role="img"
      aria-label={countSummary(counts)}
      className="flex h-1.5 w-20 shrink-0 gap-px overflow-hidden rounded-full"
    >
      {sorted.map((kind, index) => (
        <span key={index} className={cn("min-w-0.5 flex-1", SEGMENT_CLASS_NAMES[kind])} />
      ))}
    </span>
  );
}

/** Counts up from `since` once a second. */
function Elapsed({ since }: { since: Date }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(interval);
    };
  }, []);
  return (
    <>{formatActivityDuration(Math.max(0, Math.floor((now - since.getTime()) / 1000) * 1000))}</>
  );
}

function RowMarker({ status }: { status: ChatSubagentRunStatus }) {
  switch (status.kind) {
    case "running":
      return <ActivityMarkerDot marker="progress" />;
    case "completed":
      return <ActivityMarkerDot marker="live" />;
    case "failed":
      return <ActivityMarkerDot marker="failed" />;
    case "queued":
      // Hollow until it holds a slot.
      return (
        <span
          aria-hidden="true"
          className="size-1.5 flex-none rounded-full border border-[color:var(--bo-muted-2)]"
        />
      );
    case "stopped":
      return (
        <span
          aria-hidden="true"
          className="size-1.5 flex-none rounded-full bg-[var(--bo-muted-2)]"
        />
      );
  }
  throw new Error("Unsupported subagent status.", { cause: status satisfies never });
}

/** Where a subagent stands, under its task: what it does now, what it answered, or why not. */
function RowStatus({ status }: { status: ChatSubagentRunStatus }) {
  switch (status.kind) {
    case "running":
      return (
        <span key={status.headline} className="bo-headline-enter block truncate">
          <span className="bo-shimmer-text">{status.headline}</span>
        </span>
      );
    case "completed":
      return <span className="block truncate">{status.answer}</span>;
    case "failed":
      return <span className="block truncate text-[var(--bo-failed)]">{status.reason}</span>;
    case "queued":
      return <span className="block truncate">Waiting for a free slot</span>;
    case "stopped":
      return <span className="block truncate">Stopped with its agent before it answered</span>;
  }
  throw new Error("Unsupported subagent status.", { cause: status satisfies never });
}

function RowTiming({ status }: { status: ChatSubagentRunStatus }) {
  switch (status.kind) {
    case "running":
      return <Elapsed since={status.startedAt} />;
    case "completed":
      return status.durationMs === null ? null : <>{formatActivityDuration(status.durationMs)}</>;
    case "failed":
      return <span className="font-medium text-[var(--bo-failed)]">Failed</span>;
    case "queued":
      return <>Waiting</>;
    case "stopped":
      return <>Stopped</>;
  }
  throw new Error("Unsupported subagent status.", { cause: status satisfies never });
}

/** One subagent: its task over where it stands, opening its transcript beneath. */
function SubagentRow({ subagent }: { subagent: ChatSubagentRun }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="bo-chat-enter border-t border-[color:var(--bo-border)] first:border-t-0">
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <Collapsible.Trigger className="group/subagent grid w-full grid-cols-[0.75rem_minmax(0,1fr)_auto] items-baseline gap-x-2.5 px-3 py-2.5 text-left transition-[background-color] duration-150 ease-out outline-none hover:bg-[var(--bo-panel-2)] focus-visible:bg-[var(--bo-panel-2)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:ring-inset data-[panel-open]:bg-[var(--bo-panel-2)]">
          <span className="flex h-4 items-center justify-center self-start">
            <RowMarker status={subagent.status} />
          </span>
          <span className="min-w-0 truncate text-xs font-medium text-[var(--bo-fg)]">
            {subagent.task}
          </span>
          <span className="flex items-center gap-2 text-[10px] text-[var(--bo-muted-2)] tabular-nums">
            <RowTiming status={subagent.status} />
            <span className="transition-colors duration-150 group-hover/subagent:text-[var(--bo-fg)]">
              <DisclosureChevron open={open} />
            </span>
          </span>
          {/* The open transcript tells the same, at length. */}
          <span
            aria-live={subagent.status.kind === "running" ? "polite" : undefined}
            className="col-start-2 col-end-4 mt-0.5 min-w-0 overflow-hidden text-xs leading-5 text-[var(--bo-muted)] group-data-[panel-open]/subagent:hidden"
          >
            <RowStatus status={subagent.status} />
          </span>
        </Collapsible.Trigger>
        <Collapsible.Panel className={collapsiblePanelClassName}>
          {/* The rail runs down from the row's marker, so the transcript reads as the row's. */}
          <div className="relative bg-[var(--bo-panel-2)] before:absolute before:top-0 before:bottom-3 before:left-[1.125rem] before:w-px before:bg-[var(--bo-border-strong)]">
            <div className="backoffice-scroll max-h-[28rem] overflow-y-auto overscroll-contain pt-1 pr-3 pb-4 pl-[2.125rem]">
              {subagent.transcript}
            </div>
          </div>
        </Collapsible.Panel>
      </Collapsible.Root>
    </li>
  );
}

// A large batch shows its first rows; folding only a few more would hide less than the button costs.
const FOLDED_ROWS = 5;
const FOLD_AFTER = 7;

/**
 * A batch of subagents in the thread: who asked, how far the batch got, and one row per subagent,
 * oldest first. Spreads its props so the reader can be brought to it, such as from a
 * ChatSubagentsRunning.
 */
export function ChatSubagentGroup({
  title,
  subagents,
  ...props
}: Omit<ComponentProps<"section">, "className" | "children" | "title"> & {
  /** Who started them, such as "Subagents" in the agent's own turn or "Bookkeeping" outside it. */
  title: string;
  /** Oldest first. */
  subagents: readonly ChatSubagentRun[];
}) {
  const [expanded, setExpanded] = useState(false);
  const statuses = subagents.map(({ status }) => status);
  const counts = countKinds(statuses);
  const folds = subagents.length > FOLD_AFTER && !expanded;
  const shown = folds ? subagents.slice(0, FOLDED_ROWS) : subagents;
  const active = counts.running + counts.queued > 0;
  return (
    <section
      aria-label={`${title}: ${subagents.length} subagents`}
      tabIndex={-1}
      {...props}
      // Scrolled into view clear of the composer that floats over the thread's bottom.
      className="bo-chat-enter min-w-0 scroll-mt-6 scroll-mb-56 overflow-hidden rounded-[4px] border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] outline-none"
    >
      <header className="flex min-h-11 min-w-0 items-center gap-3 border-b border-[color:var(--bo-border)] px-3">
        <Icon
          name="git-branch"
          className={cn(
            "size-3.5 flex-none",
            active ? "text-[var(--bo-accent)]" : "text-[var(--bo-muted-2)]",
          )}
        />
        <p className="flex min-w-0 flex-1 items-baseline gap-2 text-xs">
          <span className="shrink-0 font-medium text-[var(--bo-fg)]">{title}</span>
          <span className="truncate text-[10px] text-[var(--bo-muted-2)] tabular-nums">
            {countSummary(counts)}
          </span>
        </p>
        <SubagentProgress statuses={statuses} />
      </header>
      <ol>
        {shown.map((subagent) => (
          <SubagentRow key={subagent.id} subagent={subagent} />
        ))}
      </ol>
      {folds ? (
        <button
          type="button"
          onClick={() => {
            setExpanded(true);
          }}
          className="flex min-h-9 w-full items-center gap-2 border-t border-[color:var(--bo-border)] px-3 text-left text-[10px] font-medium text-[var(--bo-muted)] transition-colors duration-150 outline-none hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:ring-inset"
        >
          <Icon name="chevron-down" className="size-3.5" />
          Show {subagents.length - FOLDED_ROWS} more
          <span className="text-[var(--bo-muted-2)]">
            {countSummary(countKinds(statuses.slice(FOLDED_ROWS)))}
          </span>
        </button>
      ) : null}
    </section>
  );
}

/**
 * Above the composer while subagents run out of view: how many, and a way to their card. Place it
 * inside the ChatViewportFooter.
 */
export function ChatSubagentsRunning({
  statuses,
  onShow,
}: {
  /** The subagents of every batch still at work, settled ones included, so the bar shows progress. */
  statuses: readonly ChatSubagentRunStatus[];
  /** Brings the reader to the newest batch still at work. */
  onShow: () => void;
}) {
  const counts = countKinds(statuses);
  const atWork = counts.running + counts.queued;
  if (atWork === 0) {
    return null;
  }
  return (
    <div className="bo-chat-enter mb-2 flex min-h-11 min-w-0 items-center gap-3 rounded-[4px] border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] py-1.5 pr-1.5 pl-3 text-xs shadow-[var(--bo-popover-shadow)]">
      <Icon name="git-branch" className="size-3.5 flex-none text-[var(--bo-accent)]" />
      <p className="min-w-0 flex-1 truncate">
        <span className="font-medium text-[var(--bo-fg)]">
          {atWork === 1 ? "1 subagent at work" : `${atWork} subagents at work`}
        </span>
        <span className="text-[var(--bo-muted-2)] tabular-nums">
          {" "}
          · {counts.completed} of {statuses.length} done
        </span>
      </p>
      <SubagentProgress statuses={statuses} />
      <Button variant="secondary" onClick={onShow} className="min-h-8 px-2.5 text-xs">
        Show
      </Button>
    </div>
  );
}
