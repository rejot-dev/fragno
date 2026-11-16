import type { CodemodeCallSubject } from "@fragno-dev/backoffice-api/v0/pi";
import type { CodemodeToolCall } from "@fragno-dev/codemode/host/codemode-host-capabilities";
import { z } from "zod";

import type {
  AnyBackofficeRuntimeTool,
  BackofficeRuntimeToolFamily,
} from "@/fragno/runtime-tools/runtime-tools";

// A subject is shown as one line, for as long as the conversation it is shown in exists.
const MAX_LINE_LENGTH = 160;

function truncateLine(text: string) {
  return text.length > MAX_LINE_LENGTH ? `${text.slice(0, MAX_LINE_LENGTH - 1)}…` : text;
}

function oneLine(value: unknown) {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return truncateLine(text);
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

/** Reads, lists, and searches of the run's own files, as what they looked at. */
function stateCallSubject(tool: string, input: unknown): CodemodeCallSubject | null {
  const path = tool === "readFile" ? z.object({ path: z.string() }).safeParse(input) : null;
  if (path?.success) {
    const skill = skillName(path.data.path);
    return skill === null ? { kind: "read", path: path.data.path } : { kind: "skill", name: skill };
  }
  const pattern = tool === "glob" ? z.object({ pattern: z.string() }).safeParse(input) : null;
  if (pattern?.success) {
    return { kind: "list", pattern: pattern.data.pattern };
  }
  const search =
    tool === "searchFiles"
      ? z.object({ pattern: z.string(), keywords: z.array(z.string()) }).safeParse(input)
      : null;
  if (search?.success) {
    return { kind: "search", keywords: search.data.keywords, pattern: search.data.pattern };
  }
  return null;
}

/**
 * Describes each call of a run by what it did, read from the input the guest gave it rather than
 * from its bounded summary, which may cut off what it names. Reads, lists, and searches of the
 * run's own files read as what they looked at, a read of a SKILL.md as the skill it loaded, an
 * integration action as its action, and any other call as its tool's activity. The guest's input
 * is unchecked, so an input the tool would refuse reads as a plain call.
 */
export function codemodeCallDescriber(families: readonly BackofficeRuntimeToolFamily[]) {
  const tools = new Map<string, AnyBackofficeRuntimeTool>(
    families.flatMap((family) =>
      family.tools.map((tool) => [`${tool.namespace}.${tool.name}`, tool] as const),
    ),
  );
  return function describeCodemodeCall(
    call: CodemodeToolCall,
    input: unknown,
  ): CodemodeCallSubject {
    if (call.provider === "state" && call.scope.kind === "current") {
      const subject = stateCallSubject(call.tool, input);
      if (subject !== null) {
        return subject;
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
    const name = `${call.provider}.${call.tool}`;
    const tool = tools.get(name);
    const parsed = tool?.inputSchema.safeParse(input);
    if (tool !== undefined && parsed?.success) {
      const target = tool.activity.target(parsed.data);
      return {
        kind: "tool",
        name,
        scope: scopeLabel(call.scope),
        label: tool.activity.label,
        target: target === null ? null : truncateLine(target),
      };
    }
    return { kind: "call", name, scope: scopeLabel(call.scope), input: oneLine(input) };
  };
}

export type CodemodeCallDescriber = ReturnType<typeof codemodeCallDescriber>;
