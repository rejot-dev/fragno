import type { BackofficeStatusTone } from "@fragno-private/design-system/status-tone";

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

export function durableHookStatusTone(status: DurableHookStatus): BackofficeStatusTone {
  switch (status) {
    case "processing":
      return "info";
    case "completed":
      return "live";
    case "failed":
      return "failed";
    case "pending":
      return "waiting";
  }
  throw new Error("Unsupported durable hook status.");
}
