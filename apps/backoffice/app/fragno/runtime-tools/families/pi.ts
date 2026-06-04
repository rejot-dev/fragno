import { z } from "zod";

import {
  assertNoPositionals,
  parseCliTokens,
  readIntegerOption,
  readJsonOption,
  readOutputOptions,
  readStringOption,
} from "@/fragno/automation/commands/cli";
import type {
  PiRuntime,
  PiSessionCreateArgs,
  PiSessionGetArgs,
  PiSessionListArgs,
  PiSessionTurnArgs,
} from "@/fragno/bash-runtime/pi-bash-runtime";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeRuntimeTool,
  type BackofficeToolContext,
} from "../runtime-tools";

type PiToolContext = BackofficeToolContext<{ pi?: PiRuntime }>;

const nonEmptyString = z.string().trim().min(1);
const unknownOutputSchema = z.unknown();

const sessionCreateInputSchema = z.object({
  agent: nonEmptyString,
  name: nonEmptyString.optional(),
  systemMessage: nonEmptyString.optional(),
  metadata: z.unknown().optional(),
  tags: z.array(nonEmptyString).optional(),
  steeringMode: z.enum(["all", "one-at-a-time"]).optional(),
});

const sessionGetInputSchema = z.object({
  sessionId: nonEmptyString,
  events: z.boolean().optional(),
  trace: z.boolean().optional(),
  turns: z.boolean().optional(),
});

const sessionListInputSchema = z.object({
  limit: z.number().int().positive().optional(),
});

const sessionTurnInputSchema = z.object({
  sessionId: nonEmptyString,
  text: nonEmptyString,
});

const definePiRuntimeTool = <TInputSchema extends z.ZodType>(
  tool: BackofficeRuntimeTool<TInputSchema, typeof unknownOutputSchema, PiToolContext>,
) => defineBackofficeRuntimeTool(tool);

const getPiRuntime = (runtime: PiToolContext["runtimes"]["pi"]): PiRuntime => {
  if (!runtime) {
    throw new Error("Pi runtime is not available in this execution context");
  }
  return runtime;
};

const parseStringArrayOption = (parsed: ReturnType<typeof parseCliTokens>["options"]) => {
  const value = parsed.get("tag");
  if (typeof value === "undefined") {
    return undefined;
  }
  if (typeof value === "boolean") {
    throw new Error("--tag requires a string value");
  }
  return Array.isArray(value) ? value : [value];
};

const parseBooleanOption = (
  parsed: ReturnType<typeof parseCliTokens>["options"],
  name: string,
): boolean | undefined => {
  const value = parsed.get(name);
  if (typeof value === "undefined") {
    return undefined;
  }
  if (Array.isArray(value)) {
    throw new Error(`--${name} specified multiple times`);
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`--${name} must be true or false`);
};

const normalizeSteeringMode = (
  value: string | undefined,
  optionName = "steering-mode",
): PiSessionCreateArgs["steeringMode"] | undefined => {
  if (typeof value === "undefined") {
    return undefined;
  }
  if (value !== "all" && value !== "one-at-a-time") {
    throw new Error(`--${optionName} must be one of: all, one-at-a-time`);
  }
  return value;
};

const parseSessionCreate = (args: string[]): PiSessionCreateArgs => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "pi.session.create");
  return {
    agent: readStringOption(parsed, "agent", true)!,
    name: readStringOption(parsed, "name") ?? undefined,
    systemMessage: readStringOption(parsed, "system-message") ?? undefined,
    metadata: readJsonOption(parsed, "metadata-json"),
    tags: parseStringArrayOption(parsed.options),
    steeringMode: normalizeSteeringMode(readStringOption(parsed, "steering-mode")),
  };
};

const parseSessionGet = (args: string[]): PiSessionGetArgs => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "pi.session.get");
  return {
    sessionId: readStringOption(parsed, "session-id", true)!,
    events: parseBooleanOption(parsed.options, "events"),
    trace: parseBooleanOption(parsed.options, "trace"),
    turns: parseBooleanOption(parsed.options, "turns"),
  };
};

const parseSessionList = (args: string[]): PiSessionListArgs => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "pi.session.list");
  return { limit: readIntegerOption(parsed, "limit") };
};

const parseSessionTurn = (args: string[]): PiSessionTurnArgs => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "pi.session.turn");
  return {
    sessionId: readStringOption(parsed, "session-id", true)!,
    text: readStringOption(parsed, "text", true)!,
  };
};

const jsonByDefaultOutputOptions = (args: string[]) => {
  const parsed = parseCliTokens(args);
  const output = readOutputOptions(parsed);
  return output.print || parsed.options.has("format")
    ? output
    : { ...output, format: "json" as const };
};

const sessionCreateTool = definePiRuntimeTool({
  id: "pi.session.create",
  namespace: "pi",
  name: "createSession",
  description: "Create a new Pi session.",
  inputSchema: sessionCreateInputSchema,
  outputSchema: unknownOutputSchema,
  execute: async (input, context) => getPiRuntime(context.runtimes.pi).createSession(input),
  adapters: {
    bash: {
      command: "pi.session.create",
      help: {
        summary: "pi.session.create creates a new Pi session via the existing Pi session route.",
        options: [
          {
            name: "agent",
            required: true,
            valueRequired: true,
            valueName: "agent",
            description: "Pi agent identifier",
          },
          {
            name: "name",
            valueRequired: true,
            valueName: "name",
            description: "Optional display name for the session",
          },
          {
            name: "system-message",
            valueRequired: true,
            valueName: "text",
            description:
              "Additional system message to append to the configured agent system prompt for this session",
          },
          {
            name: "tag",
            valueRequired: true,
            valueName: "tag",
            description: "Repeatable session tag",
          },
          {
            name: "metadata-json",
            valueRequired: true,
            valueName: "json",
            description: "Arbitrary JSON metadata object",
          },
          {
            name: "steering-mode",
            valueRequired: true,
            valueName: "steering-mode",
            description: "Set the session steering mode (all|one-at-a-time)",
          },
        ],
        examples: [
          `pi.session.create --agent assistant --name onboarding --tag team-alpha --tag priority --metadata-json '{"purpose":"support"}'`,
          'pi.session.create --agent assistant --system-message "You are operating in staging mode." --format json',
          "pi.session.create --agent assistant --steering-mode one-at-a-time --format json",
        ],
      },
      parse: parseSessionCreate,
      format: (data) => ({ data }),
    },
  },
});

const sessionGetTool = definePiRuntimeTool({
  id: "pi.session.get",
  namespace: "pi",
  name: "getSession",
  description: "Retrieve a Pi session by id.",
  inputSchema: sessionGetInputSchema,
  outputSchema: unknownOutputSchema,
  execute: async (input, context) => getPiRuntime(context.runtimes.pi).getSession(input),
  adapters: {
    bash: {
      command: "pi.session.get",
      help: {
        summary: "pi.session.get retrieves a Pi session detail by id.",
        options: [
          {
            name: "session-id",
            required: true,
            valueRequired: true,
            valueName: "session-id",
            description: "Pi session id to retrieve",
          },
          {
            name: "events",
            valueRequired: false,
            description: "Include event history in response",
          },
          { name: "trace", valueRequired: false, description: "Include runtime trace in response" },
          { name: "turns", valueRequired: false, description: "Include turn records in response" },
        ],
        examples: [
          "pi.session.get --session-id session-123",
          "pi.session.get --session-id session-123 --format json --print workflow.status",
        ],
      },
      parse: parseSessionGet,
      format: (data) => ({ data }),
    },
  },
});

const sessionListTool = definePiRuntimeTool({
  id: "pi.session.list",
  namespace: "pi",
  name: "listSessions",
  description: "List Pi sessions ordered by creation time.",
  inputSchema: sessionListInputSchema,
  outputSchema: unknownOutputSchema,
  execute: async (input, context) => getPiRuntime(context.runtimes.pi).listSessions(input),
  adapters: {
    bash: {
      command: "pi.session.list",
      help: {
        summary: "pi.session.list lists Pi sessions ordered by creation time.",
        options: [
          {
            name: "limit",
            valueRequired: true,
            valueName: "limit",
            description: "Maximum number of sessions to return",
          },
        ],
        examples: [
          "pi.session.list",
          "pi.session.list --limit 10 --format json",
          "pi.session.list --limit 5 --print 0.id",
        ],
      },
      parse: parseSessionList,
      outputOptions: jsonByDefaultOutputOptions,
      format: (data) => ({ data }),
    },
  },
});

const sessionTurnTool = definePiRuntimeTool({
  id: "pi.session.turn",
  namespace: "pi",
  name: "runTurn",
  description: "Send one prompt command through a Pi active session and return the settled result.",
  inputSchema: sessionTurnInputSchema,
  outputSchema: unknownOutputSchema,
  execute: async (input, context) => getPiRuntime(context.runtimes.pi).runTurn(input),
  adapters: {
    bash: {
      command: "pi.session.turn",
      help: {
        summary:
          "pi.session.turn sends one prompt command through the active-session stream and returns the settled result.",
        options: [
          {
            name: "session-id",
            required: true,
            valueRequired: true,
            valueName: "session-id",
            description: "Pi session id to send the turn to",
          },
          {
            name: "text",
            required: true,
            valueRequired: true,
            valueName: "text",
            description: "User message text to send for this turn",
          },
        ],
        examples: [
          'pi.session.turn --session-id session-123 --text "Hello there" --print assistantText',
          'pi.session.turn --session-id session-123 --text "Summarize the latest messages" --format json',
        ],
      },
      parse: parseSessionTurn,
      outputOptions: jsonByDefaultOutputOptions,
      format: (data) => ({ data }),
    },
  },
});

export const piRuntimeTools = [
  sessionCreateTool,
  sessionGetTool,
  sessionListTool,
  sessionTurnTool,
] as const;

export const piToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "pi",
  tools: piRuntimeTools,
  isAvailable: (context: PiToolContext) => !!context.runtimes.pi,
});

export type {
  PiRuntime,
  PiSessionCreateArgs,
  PiSessionGetArgs,
  PiSessionListArgs,
  PiSessionTurnArgs,
};
