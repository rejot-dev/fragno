import { z } from "zod";

import { codemodeCallSubjectSchema } from "@/fragno/codemode/codemode-call-subject";
import type { CodemodeLoggedToolCall } from "@/fragno/codemode/codemode-tool-call-observer";

// Session history keeps tool results for as long as the conversation exists, while the Codemode
// object keeps a run's full calls for days. Results carry a short projection of each call.
const MAX_CALLS = 50;
const MAX_ERROR_LENGTH = 300;

const codemodeCallSchema = z.discriminatedUnion("status", [
  z.object({
    subject: codemodeCallSubjectSchema,
    offsetMs: z.number(),
    status: z.literal("running"),
  }),
  z.object({
    subject: codemodeCallSubjectSchema,
    /** When the call started, counted from when the tool call started the run. */
    offsetMs: z.number(),
    status: z.literal("succeeded"),
    durationMs: z.number(),
  }),
  z.object({
    subject: codemodeCallSubjectSchema,
    offsetMs: z.number(),
    status: z.literal("failed"),
    durationMs: z.number(),
    error: z.string(),
  }),
]);

/**
 * A codemode tool result's `details.calls`: when its run started, its newest calls, and how many
 * earlier ones it left out. A viewer keeps the run's clock from `startedAt` while it runs, and sees
 * the call running now however many came before it.
 */
export const codemodeCallsDetailSchema = z.object({
  /** Epoch milliseconds; each call's `offsetMs` counts from here. */
  startedAt: z.number(),
  items: z.array(codemodeCallSchema),
  /** The earliest calls, which `items` leaves out. */
  omitted: z.number().int().nonnegative(),
});

export type CodemodeCallsDetail = z.infer<typeof codemodeCallsDetailSchema>;

function truncate(text: string, length: number) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/**
 * Projects a run's calls, oldest first, onto the timeline of the tool call that started it at
 * `startedAt`, so a reader sees when each call happened as well as how long it took.
 */
export function codemodeCallsDetail(
  calls: readonly CodemodeLoggedToolCall[],
  startedAt: number,
): CodemodeCallsDetail {
  return {
    startedAt,
    items: calls.slice(-MAX_CALLS).map((call) => {
      const calledAt = Date.parse(call.calledAt);
      const base = { subject: call.subject, offsetMs: Math.max(0, calledAt - startedAt) };
      if (call.status === "running") {
        return { ...base, status: "running" };
      }
      const durationMs = Date.parse(call.settledAt) - calledAt;
      return call.status === "succeeded"
        ? { ...base, status: "succeeded", durationMs }
        : { ...base, status: "failed", durationMs, error: truncate(call.output, MAX_ERROR_LENGTH) };
    }),
    omitted: Math.max(0, calls.length - MAX_CALLS),
  };
}
