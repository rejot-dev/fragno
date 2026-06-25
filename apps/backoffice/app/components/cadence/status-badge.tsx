import { cn } from "@/lib/utils";

/**
 * An automation's runtime state.
 * - running:   actively executing (animated)
 * - deploying: a change is rolling out / pending
 * - succeeded: last run completed cleanly, now idle
 * - paused:    intentionally disabled
 * - failed:    last run errored
 */
export type Status = "running" | "deploying" | "succeeded" | "paused" | "failed";

const STATUS_LABEL: Record<Status, string> = {
  running: "Running",
  deploying: "Deploying",
  succeeded: "Succeeded",
  paused: "Paused",
  failed: "Failed",
};

const STATUS_STYLE: Record<Status, { dot: string; text: string; chip: string }> = {
  running: {
    dot: "bg-[var(--cad-brass)]",
    text: "text-[var(--cad-brass-strong)]",
    chip: "border-[color:var(--cad-brass-line)] bg-[var(--cad-brass-bg)]",
  },
  deploying: {
    dot: "bg-[var(--cad-verdigris)]",
    text: "text-[var(--cad-verdigris)]",
    chip: "border-[color:var(--cad-line-strong)] bg-[var(--cad-verdigris-bg)]",
  },
  succeeded: {
    dot: "bg-[var(--cad-verdigris)]",
    text: "text-[var(--cad-muted)]",
    chip: "border-[color:var(--cad-line)] bg-[var(--cad-panel-2)]",
  },
  paused: {
    dot: "bg-[var(--cad-muted-2)]",
    text: "text-[var(--cad-muted-2)]",
    chip: "border-[color:var(--cad-line)] bg-[var(--cad-panel-2)]",
  },
  failed: {
    dot: "bg-[var(--cad-rose)]",
    text: "text-[var(--cad-rose)]",
    chip: "border-[color:var(--cad-rose)]/60 bg-[var(--cad-rose-bg)]",
  },
};

export function StatusBadge({ status, className }: { status: Status; className?: string }) {
  const style = STATUS_STYLE[status];
  const animate = status === "running" || status === "deploying";
  return (
    <span
      className={cn(
        "cad-eyebrow inline-flex items-center gap-2 rounded-lg border px-2.5 py-1",
        style.chip,
        style.text,
        className,
      )}
    >
      <span
        aria-hidden
        className={cn("h-1.5 w-1.5 rounded-full", style.dot, animate ? "cad-pulse" : "")}
      />
      {STATUS_LABEL[status]}
    </span>
  );
}
