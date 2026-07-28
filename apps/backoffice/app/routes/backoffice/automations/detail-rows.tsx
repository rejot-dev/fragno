import { Link } from "react-router";

import type { AutomationRouteDetailRow } from "./route-action";

export function AutomationDetailRows({
  rows,
  layout,
  compact = false,
}: {
  rows: AutomationRouteDetailRow[];
  layout: "route" | "inspector";
  compact?: boolean;
}) {
  const rowClassName =
    layout === "inspector"
      ? "grid grid-cols-[7rem_minmax(0,1fr)] gap-2 px-3 py-2.5"
      : `grid gap-1.5 px-3 py-2.5 ${compact ? "grid-cols-[6rem_minmax(0,1fr)]" : "md:grid-cols-[9rem_1fr] md:px-4 md:py-3"}`;
  const labelClassName =
    layout === "inspector"
      ? "text-[9px] tracking-[0.14em] text-[var(--bo-muted-2)] uppercase"
      : "text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase";

  return (
    <dl className="divide-y divide-[color:var(--bo-border)]">
      {rows.map((row) => (
        <div key={row.label} className={rowClassName}>
          <dt className={labelClassName}>{row.label}</dt>
          <dd className="min-w-0 font-mono text-[11px] break-all text-[var(--bo-fg)]">
            {row.to ? (
              <Link
                to={row.to}
                className="inline-flex min-h-10 items-center text-sky-700 transition-colors hover:text-sky-900 hover:underline dark:text-sky-300 dark:hover:text-sky-100"
              >
                {row.value}
              </Link>
            ) : (
              row.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
