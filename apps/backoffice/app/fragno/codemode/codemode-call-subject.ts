import type { CodemodeToolCall } from "@fragno-dev/codemode/host/codemode-host-capabilities";
import { z } from "zod";

// A subject is shown as one line, for as long as the conversation it is shown in exists.
const MAX_INPUT_LENGTH = 160;

export const codemodeCallSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("skill"), name: z.string() }),
  z.object({ kind: z.literal("read"), path: z.string() }),
  z.object({ kind: z.literal("list"), pattern: z.string() }),
  z.object({ kind: z.literal("search"), keywords: z.array(z.string()), pattern: z.string() }),
  z.object({
    kind: z.literal("action"),
    connectionId: z.string(),
    actionId: z.string(),
    /** The scope a context handle named, such as "org:acme"; null for the run's own scope. */
    scope: z.string().nullable(),
    /** The action's own input, cut to one line. */
    input: z.string(),
  }),
  z.object({
    kind: z.literal("call"),
    /** `provider.tool`, as the program called it. */
    name: z.string(),
    scope: z.string().nullable(),
    input: z.string(),
  }),
]);

/** What a call did, as a reader of the run cares. */
export type CodemodeCallSubject = z.infer<typeof codemodeCallSubjectSchema>;

function oneLine(value: unknown) {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > MAX_INPUT_LENGTH ? `${text.slice(0, MAX_INPUT_LENGTH - 1)}…` : text;
}

function scopeLabel(scope: CodemodeToolCall["scope"]) {
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

/** A skill is the directory its SKILL.md sits in. */
function skillName(path: string) {
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) === "SKILL.md" ? (segments.at(-2) ?? null) : null;
}

const actionInputSchema = z.object({
  connectionId: z.string(),
  actionId: z.string(),
  input: z.unknown(),
});

/**
 * What a call did, read from the input the guest gave it rather than from its bounded summary, which
 * may cut off what it names. Reads, lists, and searches of the run's own files read as what they
 * looked at, a read of a SKILL.md as the skill it loaded, and an integration action as its action.
 * The guest's input is unchecked, so an input the tool would refuse reads as a plain call.
 */
export function codemodeCallSubject(call: CodemodeToolCall, input: unknown): CodemodeCallSubject {
  if (call.provider === "state" && call.scope.kind === "current") {
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
  const action =
    call.provider === "integrations" && call.tool === "execute"
      ? actionInputSchema.safeParse(input)
      : null;
  if (action?.success) {
    return {
      kind: "action",
      connectionId: action.data.connectionId,
      actionId: action.data.actionId,
      scope: scopeLabel(call.scope),
      input: oneLine(action.data.input),
    };
  }
  return {
    kind: "call",
    name: `${call.provider}.${call.tool}`,
    scope: scopeLabel(call.scope),
    input: oneLine(input),
  };
}
