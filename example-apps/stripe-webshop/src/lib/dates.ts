export const formatDate = (value: unknown) => {
  if (value === null || value === undefined || value === "") {
    return "N/A";
  }

  const date =
    value instanceof Date
      ? value
      : typeof value === "number" || typeof value === "string"
        ? new Date(value)
        : null;

  if (!date || Number.isNaN(date.getTime())) {
    return "Invalid Date";
  }

  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
};
