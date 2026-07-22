function createLocalCalendarDate(year: number, monthIndex: number, day: number): Date {
  const date = new Date(0);
  date.setFullYear(year, monthIndex, day);
  date.setHours(0, 0, 0, 0);
  return date;
}

export function parseOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TypeError(`${fieldName} must be a string or undefined`);
  }
  return value;
}

export function parseDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return undefined;
  }

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = createLocalCalendarDate(year, monthIndex, day);

  if (date.getFullYear() !== year || date.getMonth() !== monthIndex || date.getDate() !== day) {
    return undefined;
  }

  return date;
}

export function formatDateForDisplay(date: Date): string {
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}

export function parseDateTimeForPicker(value: string | undefined): {
  date: Date | undefined;
  time: string;
} {
  if (!value) {
    return { date: undefined, time: "" };
  }

  const instant = new Date(value);
  if (isNaN(instant.getTime())) {
    return { date: undefined, time: "" };
  }

  return {
    date: createLocalCalendarDate(
      instant.getUTCFullYear(),
      instant.getUTCMonth(),
      instant.getUTCDate(),
    ),
    time: `${String(instant.getUTCHours()).padStart(2, "0")}:${String(
      instant.getUTCMinutes(),
    ).padStart(2, "0")}`,
  };
}

export function formatDateTimeForSave(date: Date | undefined, time: string): string | undefined {
  if (!date) {
    return undefined;
  }

  const [hours, minutes] = time ? time.split(":").map(Number) : [0, 0];
  return new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), hours || 0, minutes || 0),
  ).toISOString();
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
