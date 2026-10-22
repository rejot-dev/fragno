import { z } from "zod";

export const INTERVAL_LIMITS = { count: 60, minimumMs: 60_000 } as const;

/** Consecutive `every`-long intervals from `since`, a negative offset from now, through now. */
export const intervalsSchema = z
  .strictObject({
    every: z.number().int().min(INTERVAL_LIMITS.minimumMs),
    since: z.number().negative(),
  })
  .refine((intervals) => mostIntervals(intervals) <= INTERVAL_LIMITS.count, {
    message: `Intervals cover at most ${INTERVAL_LIMITS.count} intervals, counting the one now falls in.`,
  });

export type Intervals = z.infer<typeof intervalsSchema>;

/**
 * The most intervals `intervalStarts` yields for a window: those `since` spans, plus the one now
 * falls in, as now rarely sits on a boundary.
 */
export function mostIntervals({ every, since }: { every: number; since: number }): number {
  return Math.ceil(-since / every) + 1;
}

/**
 * Interval starts aligned to whole `every`s, oldest first, from the one `since` falls in through
 * the one now falls in. Page buckets and chart axes both read them, so bucketed rows line up.
 */
export function intervalStarts(now: number, { every, since }: Intervals): number[] {
  const first = Math.floor((now + since) / every) * every;
  const newest = Math.floor(now / every) * every;
  return Array.from({ length: (newest - first) / every + 1 }, (_, index) => first + index * every);
}

const DAY_MS = 86_400_000;
const dayFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
// Intervals within a day carry their date, because a day-long window starts and ends at one hour.
const timeFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

export function intervalLabel(start: number, every: number): string {
  return `${(every % DAY_MS === 0 ? dayFormat : timeFormat).format(start)} UTC`;
}
