import type { BackofficeStatusTone } from "./status-tone";

/** Completion of a bounded job, such as an import, as a percentage. */
export function ProgressMeter({
  tone,
  label,
  percent,
  detail,
}: {
  tone: BackofficeStatusTone;
  label: string;
  /** Clamped to 0–100. */
  percent: number;
  detail?: string;
}) {
  const value = Math.min(100, Math.max(0, percent));

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      aria-valuetext={`${value}%${detail ? ` · ${detail}` : ""}`}
      data-tone={tone}
      className="bo-status-tone bo-status-surface border p-3"
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[9px] font-semibold tracking-[0.18em] uppercase">{label}</p>
        <p className="text-xs font-semibold tabular-nums">{value}%</p>
      </div>
      <div className="mt-2 h-1.5 bg-[var(--bo-panel)]" aria-hidden="true">
        <div className="h-full bg-[var(--bo-status-color)]" style={{ width: `${value}%` }} />
      </div>
      {detail ? <p className="mt-2 text-[10px] text-[var(--bo-fg)]">{detail}</p> : null}
    </div>
  );
}
