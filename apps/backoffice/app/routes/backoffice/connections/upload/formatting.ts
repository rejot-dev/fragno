const UPLOAD_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

export const formatUploadTimestamp = (value?: string | Date | null) => {
  if (!value) {
    return "";
  }

  return UPLOAD_TIMESTAMP_FORMATTER.format(value instanceof Date ? value : new Date(value));
};
