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

export function formatStepLine(step: Record<string, unknown>): string {
  const stepKey = String(step["stepKey"] ?? "-");
  const name = String(step["name"] ?? "-");
  const type = String(step["type"] ?? "-");
  const status = String(step["status"] ?? "-");
  const attempts = String(step["attempts"] ?? "-");
  const maxAttempts = String(step["maxAttempts"] ?? "-");
  const waitEventType = step["waitEventType"] ? ` wait:${step["waitEventType"]}` : "";
  const nextRetryAt = step["nextRetryAt"] ? ` retry:${formatDate(step["nextRetryAt"])}` : "";
  const wakeAt = step["wakeAt"] ? ` wake:${formatDate(step["wakeAt"])}` : "";
  const error = step["error"]
    ? ` error:${String((step["error"] as { name?: string }).name ?? "Error")}`
    : "";

  return `${formatDate(step["createdAt"])} ${stepKey} ${name} ${type} ${status} ${attempts}/${maxAttempts}${waitEventType}${nextRetryAt}${wakeAt}${error}`;
}

export function formatEventLine(event: Record<string, unknown>): string {
  const type = String(event["type"] ?? "-");
  const deliveredAt = event["deliveredAt"] ? formatDate(event["deliveredAt"]) : "pending";
  const consumedBy = event["consumedByStepKey"] ? String(event["consumedByStepKey"]) : "-";
  return `${formatDate(event["createdAt"])} ${type} delivered:${deliveredAt} consumedBy:${consumedBy}`;
}

export function formatLogLine(log: Record<string, unknown>): string {
  const level = String(log["level"] ?? "info").toUpperCase();
  const category = String(log["category"] ?? "default");
  const message = String(log["message"] ?? "");
  const replay = log["isReplay"] ? " [replay]" : "";
  const data =
    log["data"] !== undefined && log["data"] !== null ? ` data=${formatJson(log["data"])}` : "";
  return `${formatDate(log["createdAt"])} ${level} ${category} ${message}${replay}${data}`;
}
