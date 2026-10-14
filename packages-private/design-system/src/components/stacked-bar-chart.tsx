import { cn } from "../cn";

export type StackedBarChartSeries = { id: string; label: string };

export type StackedBarChartBucket = {
  id: string;
  label: string;
  values: Readonly<Record<string, number>>;
};

// Series take colors in order; the palette avoids the failure red so a series never reads as an error.
const SERIES_COLORS = [
  "var(--bo-blue-1)",
  "var(--bo-live)",
  "var(--bo-waiting)",
  "var(--bo-blue-3)",
  "var(--bo-accent-strong)",
  "var(--bo-muted-2)",
  "var(--bo-blue-4)",
] as const;

function seriesColor(index: number) {
  return SERIES_COLORS[index % SERIES_COLORS.length];
}

/** Bars over time, each split by series, with a legend that totals every series. */
export function StackedBarChart({
  series,
  buckets,
  ariaLabel,
  className,
}: {
  series: readonly StackedBarChartSeries[];
  buckets: readonly StackedBarChartBucket[];
  ariaLabel: string;
  className?: string;
}) {
  const bucketTotal = (bucket: StackedBarChartBucket) =>
    series.reduce((total, entry) => total + (bucket.values[entry.id] ?? 0), 0);
  const maxTotal = Math.max(0, ...buckets.map(bucketTotal));
  const seriesTotals = series.map((entry) =>
    buckets.reduce((total, bucket) => total + (bucket.values[entry.id] ?? 0), 0),
  );

  return (
    <figure className={cn("flex flex-col gap-3", className)}>
      {/* The peak labels the plot's top edge, so the plot, axis, and legend share one width. */}
      <div>
        <p className="mb-1 text-[10px] leading-none text-[var(--bo-muted-2)] tabular-nums">
          {maxTotal}
        </p>
        <div
          role="img"
          aria-label={ariaLabel}
          className="relative flex h-32 items-end gap-px border-b border-[color:var(--bo-border)]"
        >
          {/* Bars are positioned after the gridline so they paint over it. */}
          <span
            aria-hidden="true"
            className="absolute inset-x-0 top-0 border-t border-dashed border-[color:var(--bo-border)]"
          />
          {buckets.map((bucket) => {
            const total = bucketTotal(bucket);
            return (
              <div
                key={bucket.id}
                title={`${bucket.label}: ${total}`}
                className="relative flex h-full min-w-0 flex-1 flex-col-reverse transition-opacity hover:opacity-80"
              >
                {series.map((entry, index) => {
                  const value = bucket.values[entry.id] ?? 0;
                  return value === 0 ? null : (
                    <div
                      key={entry.id}
                      style={{
                        height: `${(value / maxTotal) * 100}%`,
                        backgroundColor: seriesColor(index),
                      }}
                      className="min-h-px w-full"
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex justify-between text-[10px] text-[var(--bo-muted-2)] tabular-nums">
        <span>{buckets.at(0)?.label}</span>
        <span>{buckets.at(-1)?.label}</span>
      </div>
      <figcaption>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--bo-muted)]">
          {series.map((entry, index) => (
            <li key={entry.id} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                style={{ backgroundColor: seriesColor(index) }}
                className="size-2 shrink-0"
              />
              <span className="font-mono">{entry.label}</span>
              <span className="text-[var(--bo-muted-2)] tabular-nums">{seriesTotals[index]}</span>
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}
