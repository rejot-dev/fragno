export const tapScale =
  "transition-transform duration-150 ease-out active:not-disabled:scale-[0.96] disabled:active:scale-100";

const messageTimestampFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
});

const eventTimestampFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

export function formatMessageTimestamp(date?: Date) {
  if (!date) {
    return "";
  }
  return messageTimestampFormatter.format(date);
}

export function formatEventTimestamp(date?: Date) {
  if (!date) {
    return "";
  }
  return eventTimestampFormatter.format(date);
}
