import { useEffect, useState, type ReactNode } from "react";

import { cn } from "../cn";

/** Progress pulses while work runs; the others name what kind of activity settled. */
export type ActivityMarker = "progress" | "live" | "failed" | "accent" | "notification";

/** Live marks a notable success, such as a loaded skill; failed marks an error. */
export type ActivityOutline = "default" | "live" | "failed";

const MARKER_CLASS_NAMES: Record<ActivityMarker, string> = {
  progress: "animate-pulse bg-[var(--bo-accent)]",
  live: "bg-[var(--bo-live)]",
  failed: "bg-[var(--bo-failed)]",
  accent: "bg-[var(--bo-accent)]",
  notification: "bg-amber-500",
};

const OUTLINE_CLASS_NAMES: Record<ActivityOutline, string> = {
  default: "border-[color:var(--bo-border)]",
  live: "border-[color:var(--bo-live)]",
  failed: "border-[color:var(--bo-failed)]",
};

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

export function ActivityMarkerDot({ marker }: { marker: ActivityMarker }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-1.5 flex-none rounded-full", MARKER_CLASS_NAMES[marker])}
    />
  );
}

/**
 * One collapsible entry in an activity log, such as a tool call or a compaction: a summary row
 * with a marker, title, optional note and detail, and time, over a body shown on demand.
 */
export function ActivityDisclosure({
  marker,
  outline = "default",
  title,
  note,
  detail,
  time,
  autoOpen = false,
  children,
}: {
  marker: ActivityMarker | null;
  outline?: ActivityOutline;
  title: ReactNode;
  /** Short context beside the title, such as why or through what the activity happened. */
  note?: ReactNode;
  /** A monospace column for an identifier such as a path; hidden on narrow screens. */
  detail?: string;
  time: Date | null;
  /** The entry opens or closes when this changes; readers may toggle it in between. */
  autoOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(autoOpen);

  useEffect(() => {
    setOpen(autoOpen);
  }, [autoOpen]);

  return (
    <details
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
      className={cn(
        "group/activity min-w-0 overflow-hidden border bg-[var(--bo-panel)]",
        OUTLINE_CLASS_NAMES[outline],
      )}
    >
      <summary
        className={cn(
          "grid min-h-11 cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 marker:hidden",
          detail === undefined ? null : "sm:grid-cols-[6.5rem_minmax(0,1fr)_auto]",
        )}
      >
        <span
          className={cn(
            "flex min-w-0 items-center gap-2 text-xs font-medium",
            outline === "live" ? "text-[var(--bo-live)]" : "text-[var(--bo-fg)]",
          )}
        >
          {marker === null ? null : <ActivityMarkerDot marker={marker} />}
          <span className="truncate">{title}</span>
          {note === undefined ? null : (
            <span className="truncate text-[10px] font-normal text-[var(--bo-muted-2)]">
              {note}
            </span>
          )}
        </span>
        {detail === undefined ? null : (
          <code className="hidden truncate font-mono text-[10px] text-[var(--bo-muted-2)] sm:block">
            {detail}
          </code>
        )}
        <span className="grid min-h-10 grid-cols-1 items-center text-right text-[10px] text-[var(--bo-muted-2)] transition-colors duration-150 group-hover/activity:text-[var(--bo-fg)] sm:w-[10.5rem] sm:grid-cols-[7rem_3.5rem]">
          {time === null ? (
            <span className="hidden sm:block" />
          ) : (
            <time dateTime={time.toISOString()} className="hidden tabular-nums sm:block">
              {timeFormatter.format(time)}
            </time>
          )}
          <span className="font-medium tracking-[0.1em] uppercase">
            <span className="group-open/activity:hidden">View</span>
            <span className="hidden group-open/activity:inline">Close</span>
          </span>
        </span>
      </summary>
      <div className="space-y-3 border-t border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3">
        {children}
      </div>
    </details>
  );
}
