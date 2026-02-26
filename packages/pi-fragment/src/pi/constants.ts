export const SESSION_STATUSES = [
  "active",
  "paused",
  "errored",
  "terminated",
  "complete",
  "waiting",
] as const;
export const STEERING_MODES = ["all", "one-at-a-time"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type PiSessionStatus = (typeof SESSION_STATUSES)[number];
export type PiSteeringMode = (typeof STEERING_MODES)[number];
export type PiThinkingLevel = (typeof THINKING_LEVELS)[number];
