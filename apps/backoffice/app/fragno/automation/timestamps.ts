export type AutomationTimestampInput = Date | string | number | { tag?: string; offsetMs?: number };

export const automationTimestampToIsoString = (value: AutomationTimestampInput): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "object") {
    return value.tag === "db-now"
      ? new Date(Date.now() + (value.offsetMs ?? 0)).toISOString()
      : new Date().toISOString();
  }

  return new Date(value).toISOString();
};

export const automationTimestampToDate = (value: AutomationTimestampInput): Date =>
  new Date(automationTimestampToIsoString(value));
