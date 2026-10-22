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
