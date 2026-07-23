const timestampFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

export const formatTimestamp = (value?: string | Date | null) => {
  if (!value) {
    return "";
  }
  const date = value instanceof Date ? value : new Date(value);
  return timestampFormatter.format(date);
};
