/** How a fiscal year of twelve months is divided into periods. */
export const PERIOD_LENGTHS = { month: 1, quarter: 3, year: 12 } as const;
export type PeriodLength = keyof typeof PERIOD_LENGTHS;

/**
 * The end dates of the periods of the twelve-month fiscal year starting on `startDate`, an ISO
 * date. A year starting on the 1st ends on the last day of a month; one starting later in a month
 * ends the day before that day of the month.
 */
export function periodEndDates(startDate: string, length: PeriodLength): string[] {
  const [year, month, day] = startDate.split("-").map(Number);
  const months = PERIOD_LENGTHS[length];
  return Array.from({ length: 12 / months }, (_, index) =>
    // Day 0 of a month is the last day of the month before; UTC keeps time zones out.
    isoDate(new Date(Date.UTC(year, month - 1 + (index + 1) * months, day - 1))),
  );
}

/** The day after an ISO date: where the fiscal year after one ending on `endDate` starts. */
export function dayAfter(endDate: string): string {
  const [year, month, day] = endDate.split("-").map(Number);
  return isoDate(new Date(Date.UTC(year, month - 1, day + 1)));
}

/** Today, as an ISO date in UTC. */
export function today(): string {
  return isoDate(new Date());
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
