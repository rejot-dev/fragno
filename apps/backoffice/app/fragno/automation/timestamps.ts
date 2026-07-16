import { z } from "zod";

export type AutomationTimestampInput = Date | string | number | { tag?: string; offsetMs?: number };

const isAutomationTimestampValue = (value: unknown): value is AutomationTimestampInput =>
  value instanceof Date ||
  typeof value === "number" ||
  (Boolean(value) && typeof value === "object" && (value as { tag?: unknown }).tag === "db-now");

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

export const automationIsoTimestampSchema = z.preprocess(
  (value) => (isAutomationTimestampValue(value) ? automationTimestampToIsoString(value) : value),
  z.iso.datetime(),
);
