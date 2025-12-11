// TODO: What kind of format is this parsing?
export function parseDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return isNaN(date.getTime()) ? undefined : date;
}

// Format as YYYY-MM-DD while preserving local date. Using toISOString().slice(0,10) would
// convert to UTC, potentially shifting the date near midnight in non-UTC timezones.
export function formatDateForSave(date: Date | undefined): string | undefined {
  if (!date) {
    return undefined;
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Convert "HH:mm:ss" to "HH:mm" for the native time input
export function toTimeInputValue(value: string | undefined): string {
  if (!value) {
    return "";
  }
  // Handle both "HH:mm" and "HH:mm:ss" formats
  return value.substring(0, 5);
}

// Convert "HH:mm" from native input to "HH:mm:ss" for JSON Schema time format
export function formatTimeForSave(value: string): string | undefined {
  if (!value) {
    return undefined;
  }
  // Native time input returns "HH:mm", append ":00" for seconds
  return value.length === 5 ? `${value}:00` : value;
}

// Extract "HH:mm" from a Date object
export function formatTimeFromDate(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}
