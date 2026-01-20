export function formatDate(value: unknown): string {
  if (value === null || value === undefined) {
    return "-";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
    return String(value);
  }
  return String(value);
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
