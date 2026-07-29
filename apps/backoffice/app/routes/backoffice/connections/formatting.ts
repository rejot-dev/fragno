const CONNECTION_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

export const formatTimestamp = (value?: string | Date | null) => {
  if (!value) {
    return "";
  }

  return CONNECTION_TIMESTAMP_FORMATTER.format(value instanceof Date ? value : new Date(value));
};
