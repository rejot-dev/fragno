import { cn } from "../cn";

type OperationNoticeTone = "progress" | "neutral" | "failed";

/** The state of a long operation, such as a context compaction, where its result will appear. */
export function OperationNotice({
  tone,
  title,
  description,
  onRetry,
}: {
  tone: OperationNoticeTone;
  title: string;
  description: string;
  /** Offered only when the operation failed. */
  onRetry?: () => unknown;
}) {
  const failed = tone === "failed";
  return (
    <div
      role={failed ? "alert" : "status"}
      aria-live={tone === "progress" ? "polite" : undefined}
      className={cn(
        "flex min-h-12 items-center justify-between gap-3 border px-3 py-2 text-xs",
        failed
          ? "border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] text-[var(--bo-failed)]"
          : "border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] text-[var(--bo-muted)]",
      )}
    >
      <span className="flex min-w-0 items-center gap-3">
        {tone === "progress" ? (
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 animate-pulse bg-[var(--bo-accent)]"
          />
        ) : null}
        <span className="min-w-0 text-pretty">
          <span className={cn("block font-medium", failed ? null : "text-[var(--bo-fg)]")}>
            {title}
          </span>
          <span
            className={cn(
              "mt-0.5 block text-[10px]",
              failed ? "opacity-80" : "text-[var(--bo-muted-2)]",
            )}
          >
            {description}
          </span>
        </span>
      </span>
      {failed && onRetry ? (
        <button
          type="button"
          onClick={() => void onRetry()}
          className="inline-flex min-h-10 shrink-0 items-center px-3 text-[10px] font-semibold transition-[background-color,scale] duration-150 ease-out hover:bg-[var(--bo-panel)] active:scale-[0.96]"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
