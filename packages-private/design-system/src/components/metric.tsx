import type { BackofficeStatusTone } from "./status-tone";

/**
 * One labeled figure, such as an order count, with optional context below it. Metrics sit flat on
 * the page as panels do; a tone colors only the figure, such as a loss in "failed". "info" leaves
 * it plain: pages mark their headline figure info, and a large figure in the accent reads as a
 * link.
 */
export function Metric({
  tone,
  label,
  value,
  detail,
}: {
  tone: BackofficeStatusTone | null;
  label: string;
  value: string;
  detail?: string;
}) {
  const figureTone = tone === "info" ? null : tone;
  return (
    <section aria-label={label} className="min-w-0">
      <p className="text-[10px] tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">{label}</p>
      {/* A figure wraps rather than truncating: a hidden digit reads as a different amount. */}
      <p
        data-tone={figureTone ?? undefined}
        className={`mt-1.5 text-2xl leading-tight font-semibold [overflow-wrap:anywhere] tabular-nums ${figureTone === null ? "text-[var(--bo-fg)]" : "bo-status-tone text-[var(--bo-status-color)]"}`}
      >
        {value}
      </p>
      {detail ? <p className="mt-1 text-xs leading-5 text-[var(--bo-muted)]">{detail}</p> : null}
    </section>
  );
}
