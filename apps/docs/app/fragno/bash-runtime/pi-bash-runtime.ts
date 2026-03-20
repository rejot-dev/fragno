import { createRouteCaller } from "@fragno-dev/core/api";

import type { PiSession, PiSessionDetail, createPiFragment } from "@fragno-dev/pi-fragment";

import { createAutomationCommands } from "../automation/commands/bash-adapter";

type PiFragment = ReturnType<typeof createPiFragment>;
import {
  assertNoPositionals,
  parseCliTokens,
  readIntegerOption,
  readJsonOption,
  readOutputOptions,
  readStringOption,
} from "../automation/commands/cli";
import type {
  AutomationCommandHelp,
  AutomationCommandHandlersFor,
  AutomationCommandSpec,
  ParsedCommand,
} from "../automation/commands/types";
import type { BashCommandFactoryInput } from "./bash-host";

const PI_COMMAND_NAMES = ["pi.session.create", "pi.session.get", "pi.session.list"] as const;

type PiCommandName = (typeof PI_COMMAND_NAMES)[number];

export type PiSessionCreateArgs = {
  agent: string;
  name?: string;
  metadata?: unknown;
  tags?: string[];
  steeringMode?: "all" | "one-at-a-time";
};

export type PiSessionGetArgs = {
  sessionId: string;
  events?: boolean;
  trace?: boolean;
  summaries?: boolean;
};

export type PiSessionListArgs = {
  limit?: number;
};

type PiParsedCommandByName = {
  "pi.session.create": ParsedCommand<"pi.session.create", PiSessionCreateArgs>;
  "pi.session.get": ParsedCommand<"pi.session.get", PiSessionGetArgs>;
  "pi.session.list": ParsedCommand<"pi.session.list", PiSessionListArgs>;
};

type PiCommandHandlers<TContext = unknown> = AutomationCommandHandlersFor<
  TContext,
  PiParsedCommandByName
>;

export type PiBashRuntime = {
  createSession: (args: PiSessionCreateArgs) => Promise<PiSession>;
  getSession: (args: PiSessionGetArgs) => Promise<PiSessionDetail>;
  listSessions: (args: PiSessionListArgs) => Promise<PiSession[]>;
};

type RegisteredPiBashCommandContext = {
  runtime: PiBashRuntime;
};

type PiBashRegistryContext = {
  pi?: RegisteredPiBashCommandContext;
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

  if (typeof value !== "string") {
    return undefined;
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

const HELP: {
  sessionCreate: AutomationCommandHelp;
  sessionGet: AutomationCommandHelp;
  sessionList: AutomationCommandHelp;
} = {
  sessionCreate: {
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
      'pi.session.create --agent assistant --name onboarding --tag team-alpha --tag priority --metadata-json \'{"purpose":"support"}\'',
      "pi.session.create --agent assistant --steering-mode one-at-a-time --format json",
    ],
  },
  sessionGet: {
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
      {
        name: "trace",
        valueRequired: false,
        description: "Include runtime trace in response",
      },
      {
        name: "summaries",
        valueRequired: false,
        description: "Include turn summaries in response",
      },
    ],
    examples: [
      "pi.session.get --session-id session-123",
      "pi.session.get --session-id session-123 --format json --print workflow.status",
    ],
  },
  sessionList: {
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
};

const parsePiSessionCreate = (args: string[]): PiParsedCommandByName["pi.session.create"] => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "pi.session.create");

  const tags = parseStringArrayOption(parsed.options);
  const metadata = readJsonOption(parsed, "metadata-json");
  const steeringMode = readStringOption(parsed, "steering-mode");
  if (
    typeof steeringMode === "string" &&
    steeringMode !== "all" &&
    steeringMode !== "one-at-a-time"
  ) {
    throw new Error(`--steering-mode must be one of: all, one-at-a-time`);
  }

  return {
    name: "pi.session.create",
    args: {
      agent: readStringOption(parsed, "agent", true)!,
      name: readStringOption(parsed, "name") ?? undefined,
      metadata,
      tags,
      steeringMode: steeringMode as PiSessionCreateArgs["steeringMode"],
    },
    output: readOutputOptions(parsed),
    rawArgs: args,
  };
};

const parsePiSessionGet = (args: string[]): PiParsedCommandByName["pi.session.get"] => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "pi.session.get");

  return {
    name: "pi.session.get",
    args: {
      sessionId: readStringOption(parsed, "session-id", true)!,
      events: parseBooleanOption(parsed.options, "events"),
      trace: parseBooleanOption(parsed.options, "trace"),
      summaries: parseBooleanOption(parsed.options, "summaries"),
    },
    output: readOutputOptions(parsed),
    rawArgs: args,
  };
};

const parsePiSessionList = (args: string[]): PiParsedCommandByName["pi.session.list"] => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "pi.session.list");

  const output = readOutputOptions(parsed);

  return {
    name: "pi.session.list",
    args: {
      limit: readIntegerOption(parsed, "limit"),
    },
    output: output.print || parsed.options.has("format") ? output : { ...output, format: "json" },
    rawArgs: args,
  };
};

const PI_COMMAND_SPECS = {
  "pi.session.create": {
    name: "pi.session.create",
    help: HELP.sessionCreate,
    parse: parsePiSessionCreate,
  },
  "pi.session.get": {
    name: "pi.session.get",
    help: HELP.sessionGet,
    parse: parsePiSessionGet,
  },
  "pi.session.list": {
    name: "pi.session.list",
    help: HELP.sessionList,
    parse: parsePiSessionList,
  },
} satisfies {
  [TCommandName in PiCommandName]: AutomationCommandSpec<
    TCommandName,
    PiParsedCommandByName[TCommandName]["args"]
  > & {
    parse: (args: string[]) => PiParsedCommandByName[TCommandName];
  };
};

const PI_COMMAND_SPEC_LIST = PI_COMMAND_NAMES.map(
  (name) => PI_COMMAND_SPECS[name],
) as readonly (typeof PI_COMMAND_SPECS)[PiCommandName][];

const piCommandHandlers: PiCommandHandlers<RegisteredPiBashCommandContext> = {
  "pi.session.create": async (command, context) => {
    return {
      data: await context.runtime.createSession(command.args),
    };
  },
  "pi.session.get": async (command, context) => {
    return {
      data: await context.runtime.getSession(command.args),
    };
  },
  "pi.session.list": async (command, context) => {
    return {
      data: await context.runtime.listSessions(command.args),
    };
  },
};

export const createPiBashCommands = <TContext>(input: BashCommandFactoryInput<TContext>) => {
  const piContext = (input.context as PiBashRegistryContext).pi;
  if (!piContext) {
    return [];
  }

  return createAutomationCommands(
    PI_COMMAND_SPEC_LIST,
    piCommandHandlers,
    piContext,
    input.commandCallsResult,
  );
};

const createPiRouteCaller = (env: CloudflareEnv, orgId: string) => {
  const piDo = env.PI.get(env.PI.idFromName(orgId));

  return createRouteCaller<PiFragment>({
    // Durable Object route helpers still need absolute URLs, so use a synthetic origin.
    baseUrl: "https://pi.do",
    mountRoute: "/api/pi",
    fetch: async (outboundRequest) => {
      const url = new URL(outboundRequest.url);
      url.searchParams.set("orgId", orgId);
      return piDo.fetch(new Request(url.toString(), outboundRequest));
    },
  });
};

const isSuccessStatus = (status: number) => status >= 200 && status < 300;

const getJsonErrorMessage = (data: unknown) => {
  if (!data || typeof data !== "object") {
    return null;
  }

  const message = (data as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message : null;
};

const throwOnRouteError = (
  response:
    | ({ type: string; status: number } & { type: "error"; error: { message: string } })
    | ({ type: string; status: number } & { type: "json"; data: unknown })
    | { type: string; status: number },
  label: string,
): never => {
  if (response.type === "error" && "error" in response) {
    throw new Error(`Pi fragment returned ${response.status}: ${response.error.message}`);
  }

  if (response.type === "json" && "data" in response) {
    const message = getJsonErrorMessage(response.data);
    if (message) {
      throw new Error(`Pi fragment returned ${response.status}: ${message}`);
    }
  }

  throw new Error(`Pi fragment returned ${response.status} (${label})`);
};

export const createPiRouteBashRuntime = ({
  env,
  orgId,
}: {
  env: CloudflareEnv;
  orgId: string;
}): PiBashRuntime => {
  const normalizedOrgId = orgId.trim();
  if (!normalizedOrgId) {
    throw new Error("pi.session commands require an organisation id");
  }

  const callRoute = createPiRouteCaller(env, normalizedOrgId);

  return {
    createSession: async (args) => {
      const response = await callRoute("POST", "/sessions", { body: args });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return throwOnRouteError(response, "pi.session.create");
    },
    getSession: async ({ sessionId, events, trace, summaries }) => {
      const query: Record<string, string> = {};
      if (typeof events === "boolean") {
        query.events = String(events);
      }
      if (typeof trace === "boolean") {
        query.trace = String(trace);
      }
      if (typeof summaries === "boolean") {
        query.summaries = String(summaries);
      }

      const response = await callRoute("GET", "/sessions/:sessionId", {
        pathParams: { sessionId },
        query,
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return throwOnRouteError(response, "pi.session.get");
    },
    listSessions: async ({ limit }) => {
      const query: Record<string, string> = {};
      if (typeof limit === "number") {
        query.limit = String(limit);
      }

      const response = await callRoute("GET", "/sessions", { query });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return throwOnRouteError(response, "pi.session.list");
    },
  };
};
