import { z } from "zod";

import type { CodemodeRunToolCall } from "@/fragno/codemode/codemode-fragment";

// Session history keeps tool results for as long as the conversation exists, while the Codemode
// object keeps a run's full calls for days. Results carry a short projection of each call.
const MAX_CALLS = 50;
const MAX_INPUT_LENGTH = 160;
const MAX_ERROR_LENGTH = 300;

const codemodeCallSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("skill"), name: z.string() }),
  z.object({ kind: z.literal("read"), path: z.string() }),
  z.object({ kind: z.literal("list"), pattern: z.string() }),
  z.object({ kind: z.literal("search"), keywords: z.array(z.string()), pattern: z.string() }),
  z.object({
    kind: z.literal("call"),
    /** `provider.tool`, as the program called it. */
    name: z.string(),
    /** The scope a context handle named, such as "org:acme"; null for the run's own scope. */
    scope: z.string().nullable(),
    input: z.string(),
  }),
]);

type CodemodeCallSubject = z.infer<typeof codemodeCallSubjectSchema>;

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
 * A codemode tool result's `details.calls`: when its run started, its first calls, and how many it
 * left out. A viewer keeps the run's clock from `startedAt` while it runs.
 */
export const codemodeCallsDetailSchema = z.object({
  /** Epoch milliseconds; each call's `offsetMs` counts from here. */
  startedAt: z.number(),
  items: z.array(codemodeCallSchema),
  omitted: z.number().int().nonnegative(),
});

export type CodemodeCallsDetail = z.infer<typeof codemodeCallsDetailSchema>;

function truncate(text: string, length: number) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function scopeLabel(scope: CodemodeRunToolCall["scope"]) {
  switch (scope.kind) {
    case "current":
      return null;
    case "org":
      return `org:${scope.orgId}`;
    case "user":
      return `user:${scope.userId}`;
    case "project":
      return `project:${scope.projectId}`;
  }
  throw new Error("Unsupported codemode call scope.", { cause: scope satisfies never });
}

/** The input a call recorded, or null when its summary was cut short of valid JSON. */
function recordedInput(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

/** A skill is the directory its SKILL.md sits in. */
function skillName(path: string) {
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) === "SKILL.md" ? (segments.at(-2) ?? null) : null;
}

/**
 * What a call did, as a reader of the conversation cares: reads, lists, and searches of the run's
 * own files read as what they looked at, and a read of a SKILL.md as the skill it loaded.
 */
function callSubject(call: CodemodeRunToolCall): CodemodeCallSubject {
  if (call.provider === "state" && call.scope.kind === "current") {
    const input = recordedInput(call.input);
    const path = call.tool === "readFile" ? z.object({ path: z.string() }).safeParse(input) : null;
    if (path?.success) {
      const skill = skillName(path.data.path);
      return skill === null
        ? { kind: "read", path: path.data.path }
        : { kind: "skill", name: skill };
    }
    const pattern =
      call.tool === "glob" ? z.object({ pattern: z.string() }).safeParse(input) : null;
    if (pattern?.success) {
      return { kind: "list", pattern: pattern.data.pattern };
    }
    const search =
      call.tool === "searchFiles"
        ? z.object({ pattern: z.string(), keywords: z.array(z.string()) }).safeParse(input)
        : null;
    if (search?.success) {
      return { kind: "search", keywords: search.data.keywords, pattern: search.data.pattern };
    }
  }
  return {
    kind: "call",
    name: `${call.provider}.${call.tool}`,
    scope: scopeLabel(call.scope),
    input: truncate(call.input, MAX_INPUT_LENGTH),
  };
}

/**
 * Projects a run's calls, oldest first, onto the timeline of the tool call that started it at
 * `startedAt`, so a reader sees when each call happened as well as how long it took.
 */
export function codemodeCallsDetail(
  calls: readonly CodemodeRunToolCall[],
  startedAt: number,
): CodemodeCallsDetail {
  return {
    startedAt,
    items: calls.slice(0, MAX_CALLS).map((call) => {
      const calledAt = Date.parse(call.calledAt);
      const base = { subject: callSubject(call), offsetMs: Math.max(0, calledAt - startedAt) };
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
