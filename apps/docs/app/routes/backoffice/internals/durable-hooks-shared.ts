import type { DurableHookQueueEntry } from "@/fragno/durable-hooks";

type DurableHookStatus = DurableHookQueueEntry["status"];

export const formatTimestamp = (value?: string | Date | null) => {
  if (!value) {
    return "";
  }
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
};

export const formatPayload = (payload: unknown) => {
  if (payload === undefined) {
    return "";
  }
  if (payload === null) {
    return "null";
  }
  try {
    const serialized = JSON.stringify(payload, null, 2);
    return serialized ?? String(payload);
  } catch {
    return String(payload);
  }
};

export const getStatusBadgeClasses = (status: DurableHookStatus) => {
  switch (status) {
    case "processing":
      return "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]";
    case "completed":
      return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200";
    case "failed":
      return "border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200";
    case "pending":
    default:
      return "border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] text-[var(--bo-muted)]";
  }
};
