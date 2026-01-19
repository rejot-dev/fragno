import type { WorkflowDuration } from "./workflow";

export const parseDurationMs = (duration: WorkflowDuration): number => {
  if (typeof duration === "number") {
    return duration;
  }

  const trimmed = duration.trim();
  if (!trimmed) {
    throw new Error("Invalid duration");
  }

  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(\w+)?$/i);
  if (!match) {
    throw new Error(`Invalid duration: ${duration}`);
  }

  const value = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();

  switch (unit) {
    case "ms":
    case "millisecond":
    case "milliseconds":
      return value;
    case "s":
    case "sec":
    case "secs":
    case "second":
    case "seconds":
      return value * 1000;
    case "m":
    case "min":
    case "mins":
    case "minute":
    case "minutes":
      return value * 60 * 1000;
    case "h":
    case "hr":
    case "hrs":
    case "hour":
    case "hours":
      return value * 60 * 60 * 1000;
    case "d":
    case "day":
    case "days":
      return value * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Unsupported duration unit: ${unit}`);
  }
};
