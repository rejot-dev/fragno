import { cn } from "../cn";

/** A word-sized bar series for trends inside tables and lists; empty slots keep a baseline tick. */
export function SparkBars({
  values,
  ariaLabel,
  className,
}: {
  values: readonly number[];
  ariaLabel: string;
  className?: string;
}) {
  const max = Math.max(0, ...values);
  return (
    <span
      role="img"
      aria-label={ariaLabel}
      className={cn("inline-flex h-5 items-end gap-px", className)}
    >
      {values.map((value, index) => (
        <span
          // A position is the identity of its time slot.
          key={index}
          style={{ height: value === 0 ? "1px" : `${Math.max(15, (value / max) * 100)}%` }}
          className={cn(
            "w-[3px] shrink-0",
            value === 0 ? "bg-[var(--bo-border)]" : "bg-[var(--bo-blue-2)]",
          )}
        />
      ))}
    </span>
  );
}
