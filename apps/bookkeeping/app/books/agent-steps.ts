import type { ChatCodemodeCallSubject } from "@fragno-private/design-system/agents/chat-codemode-step";
import type { IconName } from "@fragno-private/design-system/icon";
import { z } from "zod";

import { BOOKKEEPING_CONNECTION_ID } from "../../workers/backoffice/connection";

export type AgentStepStatus = "running" | "succeeded" | "failed";

/**
 * A step of an agent's work, as the people whose books it reads see it: Bookkeeping's actions,
 * which they know, its reads of files, its reading of its instructions and looking up of its
 * tools, and its other work, each without what that was. A firm's agent works by the firm's skills
 * and instructions, which stay the firm's.
 */
export type AgentStep =
  | { kind: "action"; actionId: string; detail: string | null; status: AgentStepStatus }
  | { kind: GroupedStepKind; status: AgentStepStatus };

/**
 * Steps of calls that tell their reader little one by one, so consecutive ones that went well are
 * one step: reading a file, reading its instructions, looking up its tools, and other work.
 */
type GroupedStepKind = "read" | "instructions" | "tools" | "work";

/**
 * One of the agent's tool calls, and how it went: a codemode run's calls so far, or null for any
 * other tool.
 */
export type AgentToolCall = {
  status: AgentStepStatus;
  calls: readonly { subject: ChatCodemodeCallSubject; status: AgentStepStatus }[] | null;
};

const actionInput = z.record(z.string(), z.unknown());
type ActionInput = z.infer<typeof actionInput>;

/** An action's input as its call's one-line summary gives it; a summary cut short gives none. */
function inputOf(summary: string): ActionInput {
  try {
    return actionInput.safeParse(JSON.parse(summary)).data ?? {};
  } catch {
    return {};
  }
}

/** The input's fields that are there, as text, joined by spaces; null when none is. */
function fields(input: ActionInput, ...names: string[]): string | null {
  const values = names
    .map((name) => input[name])
    .filter((value) => typeof value === "string" || typeof value === "number");
  return values.length === 0 ? null : values.join(" ");
}

type ActionLine = {
  running: string;
  done: string;
  /** What the action was about, such as the account it read. */
  detail(input: ActionInput): string | null;
};

const none = () => null;

/** The fiscal year and the periods a report covers. */
function periods(input: ActionInput) {
  const from = fields(input, "fromPeriod");
  const to = fields(input, "toPeriod");
  const through = fields(input, "period");
  const span =
    from !== null && to !== null
      ? `periods ${from}–${to}`
      : through === null
        ? null
        : `period ${through}`;
  return [fields(input, "fiscalYear"), span].filter((part) => part !== null).join(", ") || null;
}

/** What the agent does running each of Bookkeeping's actions, while it runs and once it did. */
const ACTION_LINES: Partial<Record<string, ActionLine>> = {
  "books.describe": { running: "Reading the books", done: "Read the books", detail: none },
  "entries.list": {
    running: "Looking through a journal",
    done: "Looked through a journal",
    detail: (input) => fields(input, "journal"),
  },
  "entries.get": {
    running: "Reading an entry",
    done: "Read an entry",
    detail: (input) => fields(input, "journal", "number"),
  },
  "accounts.lines": {
    running: "Reading an account's lines",
    done: "Read an account's lines",
    detail: (input) => fields(input, "account"),
  },
  "reports.trial-balance": {
    running: "Drawing up the trial balance",
    done: "Drew up the trial balance",
    detail: periods,
  },
  "reports.profit-and-loss": {
    running: "Drawing up the profit and loss",
    done: "Drew up the profit and loss",
    detail: periods,
  },
  "reports.balance-sheet": {
    running: "Drawing up the balance sheet",
    done: "Drew up the balance sheet",
    detail: periods,
  },
  "parties.list": {
    running: "Listing customers and suppliers",
    done: "Listed customers and suppliers",
    detail: none,
  },
  "parties.open-items": {
    running: "Reading open items",
    done: "Read open items",
    detail: (input) => fields(input, "role", "code"),
  },
  "documents.list": { running: "Listing documents", done: "Listed documents", detail: none },
  "documents.get": {
    running: "Looking up the document",
    done: "Looked up the document",
    detail: none,
  },
  "documents.propose": { running: "Proposing the entry", done: "Proposed the entry", detail: none },
  "documents.decline": {
    running: "Declining the document",
    done: "Declined the document",
    detail: none,
  },
  "firm.ask": {
    running: "Asking the accountant",
    done: "Asked the accountant",
    detail: none,
  },
};

/** Where documents shared with the agent are, so reading one there reads a file. */
const SHARED_FILES = "/shared/";

/** The step a call is, short of a Bookkeeping action. */
function groupedStepKind(subject: ChatCodemodeCallSubject): GroupedStepKind {
  switch (subject.kind) {
    case "read":
      return subject.path.startsWith(SHARED_FILES) ? "read" : "instructions";
    case "skill":
    case "list":
    case "search":
      return "instructions";
    case "tool":
    case "call":
      // A call its tool would refuse has no label, but its name still says what it is.
      return subject.name === "models.extract"
        ? "read"
        : subject.name === "integrations.actions" || subject.name === "integrations.list"
          ? "tools"
          : "work";
    case "action":
      return "work";
  }
  throw new Error("Unsupported codemode call.", { cause: subject satisfies never });
}

/**
 * The steps of the agent's work so far, oldest first. Consecutive grouped steps of a kind are one
 * step, unless one failed: a failure stands on its own line, so a reader sees it even when the
 * agent went on.
 */
export function agentSteps(tools: readonly AgentToolCall[]): AgentStep[] {
  const steps: AgentStep[] = [];
  const grouped = (kind: GroupedStepKind, status: AgentStepStatus) => {
    const last = steps.at(-1);
    if (last?.kind === kind && last.status !== "failed" && status !== "failed") {
      if (status === "running") {
        last.status = "running";
      }
    } else {
      steps.push({ kind, status });
    }
  };
  for (const tool of tools) {
    const calls = tool.calls ?? [];
    for (const { subject, status } of calls) {
      if (subject.kind === "action" && subject.connectionId === BOOKKEEPING_CONNECTION_ID) {
        const detail = ACTION_LINES[subject.actionId]?.detail(inputOf(subject.input)) ?? null;
        steps.push({ kind: "action", actionId: subject.actionId, detail, status });
      } else {
        grouped(groupedStepKind(subject), status);
      }
    }
    // Other tools, and a codemode run before its first call, are work too, as is a run that
    // failed outside its calls, such as one whose code did not compile.
    if (calls.length === 0) {
      grouped("work", tool.status);
    } else if (tool.status === "failed" && calls.every((call) => call.status !== "failed")) {
      grouped("work", "failed");
    }
  }
  return steps;
}

/** What each grouped step says while it runs, once it did, and once it failed. */
const GROUPED_LINES: Record<
  GroupedStepKind,
  { icon: IconName; running: string; done: string; failed: string }
> = {
  read: {
    icon: "file-text",
    running: "Reading the file",
    done: "Read the file",
    failed: "Reading the file failed",
  },
  instructions: {
    icon: "book",
    running: "Reading its instructions",
    done: "Read its instructions",
    failed: "Reading its instructions failed",
  },
  tools: {
    icon: "tool",
    running: "Looking up its tools",
    done: "Looked up its tools",
    failed: "Looking up its tools failed",
  },
  work: { icon: "cpu", running: "Working", done: "Worked", failed: "Ran into a problem" },
};

/** A step as one line: what it did, what about, and how it went. */
export function agentStepLine(step: AgentStep): {
  icon: IconName;
  label: string;
  detail: string | null;
  state: "running" | "done" | "failed";
} {
  switch (step.kind) {
    case "action": {
      const line = ACTION_LINES[step.actionId] ?? {
        running: step.actionId,
        done: step.actionId,
      };
      const icon = step.actionId.startsWith("reports.") ? "bar-chart-2" : "book-open";
      return step.status === "running"
        ? { icon, label: line.running, detail: step.detail, state: "running" }
        : step.status === "failed"
          ? { icon, label: `${line.running} failed`, detail: step.detail, state: "failed" }
          : { icon, label: line.done, detail: step.detail, state: "done" };
    }
    case "read":
    case "instructions":
    case "tools":
    case "work": {
      const { icon, running, done, failed } = GROUPED_LINES[step.kind];
      return step.status === "running"
        ? { icon, label: running, detail: null, state: "running" }
        : step.status === "failed"
          ? { icon, label: failed, detail: null, state: "failed" }
          : { icon, label: done, detail: null, state: "done" };
    }
  }
  throw new Error("Unsupported agent step.", { cause: step satisfies never });
}
