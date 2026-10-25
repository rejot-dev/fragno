import type { BackofficeStatusTone } from "@fragno-private/design-system/status-tone";

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

export function workflowStatusTone(status: WorkflowInstanceStatus): BackofficeStatusTone {
  switch (status) {
    case "active":
      return "info";
    case "waiting":
      return "waiting";
    case "complete":
      return "live";
    case "errored":
      return "failed";
    case "terminated":
    case "paused":
      return "muted";
  }
  throw new Error("Unsupported workflow instance status.");
}

/** Steps and codemode runs report free-form statuses, so unknown ones read as muted. */
export function stepStatusTone(status: string): BackofficeStatusTone {
  switch (status.toLowerCase()) {
    case "complete":
    case "completed":
    case "succeeded":
      return "live";
    case "running":
    case "active":
      return "info";
    case "waiting":
      return "waiting";
    case "errored":
    case "failed":
      return "failed";
    default:
      return "muted";
  }
}
