import type { PiSessionActivity } from "@fragno-dev/pi-harness/workflow-session-projection";

const PI_SESSION_ACTIVITY_LABELS = {
  starting: "Working…",
  thinking: "Thinking…",
  writing: "Writing…",
  tool_calling: "Writing tool call…",
  running_tools: "Running tool calls…",
  working: "Working…",
} satisfies Record<Exclude<PiSessionActivity, null>, string>;

export const piSessionActivityLabel = (activity: PiSessionActivity): string | null =>
  activity ? PI_SESSION_ACTIVITY_LABELS[activity] : null;
