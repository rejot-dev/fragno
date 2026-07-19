import { z } from "zod";

import {
  defineCliArgsParser,
  parseCliTokens,
  readOutputOptions,
} from "@/fragno/runtime-tools/bash-cli";
import type {
  PiRuntime,
  PiSessionCreateArgs,
  PiSessionGetArgs,
  PiSessionListArgs,
  PiSessionTurnArgs,
} from "@/fragno/runtime-tools/families/pi-runtime";

import { isoDateTimeOutputSchema, normalizeRuntimeOutput } from "../output-schemas";
import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

type PiToolContext = BackofficeToolContext<{ pi?: PiRuntime }>;

const PI_SESSION_STATUSES = [
  "active",
  "paused",
  "errored",
  "terminated",
  "complete",
  "waiting",
] as const;

const piAgentStateSnapshotOutputSchema = z.object({
  messages: z.array(z.unknown()),
  errorMessage: z.string().optional(),
});

const workflowStatusOutputSchema = z.object({
  status: z.enum(PI_SESSION_STATUSES),
  error: z
    .object({
      name: z.string(),
      message: z.string(),
    })
    .optional(),
  output: z.unknown().optional(),
});

const sessionBaseOutputSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  status: z.enum(PI_SESSION_STATUSES).optional(),
  agent: z.string(),
  workflowName: z.string(),
  createdAt: isoDateTimeOutputSchema,
  updatedAt: isoDateTimeOutputSchema,
});

const sessionDetailBaseOutputSchema = sessionBaseOutputSchema.omit({ agent: true }).extend({
  agentName: z.string(),
  workflow: workflowStatusOutputSchema,
  agent: z.object({
    state: piAgentStateSnapshotOutputSchema,
    completedStepKeys: z.array(z.string()),
  }),
});

const sessionCreateInputSchema = z.object({
  agent: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  systemMessage: z.string().trim().min(1).optional(),
  metadata: z.unknown().optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
  steeringMode: z.enum(["all", "one-at-a-time"]).optional(),
});

const sessionGetInputSchema = z.object({
  sessionId: z.string().trim().min(1),
  events: z.boolean().optional(),
  trace: z.boolean().optional(),
  turns: z.boolean().optional(),
});

const sessionListInputSchema = z.object({
  limit: z.number().int().positive().optional(),
});

const sessionTurnInputSchema = z.object({
  sessionId: z.string().trim().min(1),
  text: z.string().trim().min(1),
});

const sessionExtraOutputSchema = {
  metadata: z.unknown().optional(),
  tags: z.array(z.string()).optional(),
  steeringMode: z.enum(["all", "one-at-a-time"]).optional(),
};

const sessionOutputSchema = sessionBaseOutputSchema.extend(sessionExtraOutputSchema);
const sessionDetailOutputSchema = sessionDetailBaseOutputSchema.extend(sessionExtraOutputSchema);

const sessionTurnOutputSchema = sessionDetailOutputSchema.extend({
  assistantText: z.string(),
  commandStatus: z.enum(PI_SESSION_STATUSES),
  stream: z.array(z.unknown()),
  terminalState: piAgentStateSnapshotOutputSchema,
});

const getPiRuntime = (runtime: PiToolContext["runtimes"]["pi"]): PiRuntime => {
  if (!runtime) {
    throw new Error("Pi runtime is not available in this execution context");
  }
  return runtime;
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

const parseSessionCreate = defineCliArgsParser<PiSessionCreateArgs>("pi.session.create", {
  agent: { required: true },
  name: {},
  systemMessage: {},
  metadata: { kind: "json", option: "metadata-json" },
  tags: { kind: "stringArray", option: "tag" },
  steeringMode: { transform: (value) => normalizeSteeringMode(value) },
});

const parseSessionGet = defineCliArgsParser<PiSessionGetArgs>("pi.session.get", {
  sessionId: { required: true },
  events: { kind: "boolean" },
  trace: { kind: "boolean" },
  turns: { kind: "boolean" },
});

const parseSessionList = defineCliArgsParser<PiSessionListArgs>("pi.session.list", {
  limit: { kind: "integer" },
});

const parseSessionTurn = defineCliArgsParser<PiSessionTurnArgs>("pi.session.turn", {
  sessionId: { required: true },
  text: { required: true },
});

const jsonByDefaultOutputOptions = (args: string[]) => {
  const parsed = parseCliTokens(args);
  const output = readOutputOptions(parsed);
  return output.print || parsed.options.has("format")
    ? output
    : { ...output, format: "json" as const };
};

const sessionCreateTool = defineBackofficeRuntimeTool({
  id: "pi.session.create",
  namespace: "pi",
  name: "createSession",
  description: "Create a new Pi session.",
  requiredPermissions: ["modify"],
  inputSchema: sessionCreateInputSchema,
  outputSchema: sessionOutputSchema,
  execute: async (input, context: PiToolContext) => {
    return sessionOutputSchema.parse(
      normalizeRuntimeOutput(await getPiRuntime(context.runtimes.pi).createSession(input)),
    );
  },
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

const sessionGetTool = defineBackofficeRuntimeTool({
  id: "pi.session.get",
  namespace: "pi",
  name: "getSession",
  description: "Retrieve a Pi session by id.",
  requiredPermissions: ["read"],
  inputSchema: sessionGetInputSchema,
  outputSchema: sessionDetailOutputSchema,
  execute: async (input, context: PiToolContext) => {
    return sessionDetailOutputSchema.parse(
      normalizeRuntimeOutput(await getPiRuntime(context.runtimes.pi).getSession(input)),
    );
  },
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

const sessionListTool = defineBackofficeRuntimeTool({
  id: "pi.session.list",
  namespace: "pi",
  name: "listSessions",
  description: "List Pi sessions ordered by creation time.",
  requiredPermissions: ["read"],
  inputSchema: sessionListInputSchema,
  outputSchema: z.array(sessionOutputSchema),
  execute: async (input, context: PiToolContext) => {
    return z
      .array(sessionOutputSchema)
      .parse(normalizeRuntimeOutput(await getPiRuntime(context.runtimes.pi).listSessions(input)));
  },
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

const sessionTurnTool = defineBackofficeRuntimeTool({
  id: "pi.session.turn",
  namespace: "pi",
  name: "runTurn",
  description: "Send one prompt command through a Pi active session and return the settled result.",
  requiredPermissions: ["modify"],
  inputSchema: sessionTurnInputSchema,
  outputSchema: sessionTurnOutputSchema,
  execute: async (input, context: PiToolContext) => {
    return sessionTurnOutputSchema.parse(
      normalizeRuntimeOutput(await getPiRuntime(context.runtimes.pi).runTurn(input)),
    );
  },
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
  permissions: {
    read: "Read Pi sessions.",
    modify: "Create Pi sessions and run turns.",
  },
  tools: piRuntimeTools,
  isAvailable: (context: PiToolContext) => !!context.runtimes.pi,
});

export type { PiRuntime };
