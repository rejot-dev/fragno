const timestampFormattersByTimeZone = new Map<string, Intl.DateTimeFormat>();

const getTimestampFormatter = (timeZone: string) => {
  const existingFormatter = timestampFormattersByTimeZone.get(timeZone);
  if (existingFormatter) {
    return existingFormatter;
  }

  const formatter = Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  });
  timestampFormattersByTimeZone.set(timeZone, formatter);
  return formatter;
};

export const formatTimestampInTimeZone = (
  value: string | Date | null | undefined,
  timeZone: string,
) => {
  if (!value) {
    return "—";
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  const formatted = getTimestampFormatter(timeZone).format(date);
  return `${formatted} ${timeZone}`;
};

export const formatTimestamp = (value?: string | Date | null) =>
  formatTimestampInTimeZone(value, "UTC");

/** The coarse distance between `value` and `now`, such as `4h ago` or `in 12m`. */
export function formatRelativeTime(value: string | Date, now: number): string {
  const distance = new Date(value).getTime() - now;
  const minutes = Math.floor(Math.abs(distance) / 60_000);
  if (minutes < 1) {
    return "now";
  }
  const amount =
    minutes < 60
      ? `${minutes}m`
      : minutes < 24 * 60
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / (24 * 60))}d`;
  return distance > 0 ? `in ${amount}` : `${amount} ago`;
}
