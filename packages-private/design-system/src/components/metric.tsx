import type { BackofficeStatusTone } from "./status-tone";

/** One labeled figure, such as an order count, with optional context below it. */
export function Metric({
  tone,
  label,
  value,
  detail,
}: {
  tone: BackofficeStatusTone;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <section
      aria-label={label}
      data-tone={tone}
      className="bo-status-tone bo-status-surface border p-3"
    >
      <p className="text-[9px] font-semibold tracking-[0.18em] uppercase opacity-80">{label}</p>
      <p className="mt-2 text-2xl leading-none font-semibold text-[var(--bo-fg)] tabular-nums">
        {value}
      </p>
      {detail ? (
        <p className="mt-2 text-[10px] leading-4 text-[var(--bo-muted)]">{detail}</p>
      ) : null}
    </section>
  );
}
