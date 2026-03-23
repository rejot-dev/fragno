import type { WorkflowInstanceStatus } from "./workflows-data";

export const formatTimestamp = (value?: string | Date | number | null) => {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  const date =
    value instanceof Date ? value : typeof value === "number" ? new Date(value) : new Date(value);
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
};

export const formatJson = (value: unknown) => {
  if (value === undefined) {
    return "";
  }
  if (value === null) {
    return "null";
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};

export const getWorkflowStatusBadgeClasses = (status: WorkflowInstanceStatus) => {
  switch (status) {
    case "active":
      return "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]";
    case "waiting":
      return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200";
    case "complete":
      return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200";
    case "errored":
      return "border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200";
    case "terminated":
      return "border-[color:var(--bo-border-strong)] bg-[var(--bo-panel-2)] text-[var(--bo-muted)]";
    case "paused":
      return "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-200";
    default:
      return "border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] text-[var(--bo-muted)]";
  }
};

export const getStepStatusBadgeClasses = (status: string) => {
  switch (status.toLowerCase()) {
    case "complete":
    case "completed":
      return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200";
    case "running":
    case "active":
      return "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]";
    case "waiting":
      return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200";
    case "errored":
    case "failed":
      return "border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200";
    case "paused":
      return "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-200";
    default:
      return "border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] text-[var(--bo-muted)]";
  }
};
