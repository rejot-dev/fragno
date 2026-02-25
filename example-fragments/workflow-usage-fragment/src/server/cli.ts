#!/usr/bin/env node

import { cli, define } from "gunshi";
import type { Args, Command } from "gunshi";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = existsSync(join(__dirname, "../../package.json"))
  ? join(__dirname, "../../package.json")
  : join(__dirname, "../../../package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
const version = packageJson.version as string;

const DEFAULT_BASE_URL = "http://127.0.0.1:4100/api/workflow-usage-fragment";

type CommandContext = { values: Record<string, unknown> };

const baseArgs = {
  "base-url": {
    type: "string",
    short: "b",
    description: "Base URL (env: WORKFLOW_USAGE_BASE_URL or BASE_URL)",
  },
  header: {
    type: "string",
    short: "H",
    description: "Extra HTTP header (repeatable), format: 'Name: value'",
    multiple: true,
  },
} as const;

const resolveBaseUrl = (ctx: CommandContext) => {
  const baseUrl =
    (ctx.values["base-url"] as string | undefined) ??
    process.env["WORKFLOW_USAGE_BASE_URL"] ??
    process.env["BASE_URL"] ??
    DEFAULT_BASE_URL;
  return baseUrl.replace(/\/$/, "");
};

const normalizeHeaderValues = (value: unknown): string[] => {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map(String);
  }
  return [String(value)];
};

const buildHeaders = (values: string[]) => {
  const headers = new Headers();
  for (const entry of values) {
    const index = entry.indexOf(":");
    if (index === -1) {
      throw new Error(`Invalid header: ${entry}`);
    }
    const name = entry.slice(0, index).trim();
    const value = entry.slice(index + 1).trim();
    if (!name || !value) {
      throw new Error(`Invalid header: ${entry}`);
    }
    headers.append(name, value);
  }
  return headers;
};

const parseJsonValue = (label: string, value: string | undefined) => {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label} JSON: ${message}`);
  }
};

const requestJson = async (
  ctx: CommandContext,
  options: {
    method: string;
    path: string;
    body?: unknown;
  },
) => {
  const baseUrl = resolveBaseUrl(ctx);
  const url = `${baseUrl}${options.path}`;
  const headers = buildHeaders(normalizeHeaderValues(ctx.values["header"]));

  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, {
    method: options.method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch (err) {
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}: ${text}`);
      }
      throw err;
    }
  }

  if (!response.ok) {
    const message = typeof data === "string" ? data : JSON.stringify(data ?? text);
    throw new Error(`${response.status} ${response.statusText}: ${message}`);
  }

  return data;
};

const printJson = (value: unknown) => {
  console.log(JSON.stringify(value, null, 2));
};

const sessionsListCommand = define({
  name: "list",
  description: "List sessions",
  args: {
    ...baseArgs,
    limit: {
      type: "number",
      short: "l",
      description: "Max sessions to return",
    },
  },
  run: async (ctx) => {
    const limit = ctx.values["limit"] as number | undefined;
    const query = typeof limit === "number" ? `?limit=${limit}` : "";
    const result = await requestJson(ctx, {
      method: "GET",
      path: `/sessions${query}`,
    });
    printJson(result);
  },
});

const sessionsCreateCommand = define({
  name: "create",
  description: "Create a session",
  args: {
    ...baseArgs,
    agent: {
      type: "string",
      short: "a",
      description: "Agent name",
    },
    name: {
      type: "string",
      description: "Optional session name",
    },
    metadata: {
      type: "string",
      description: "JSON metadata for the session",
    },
  },
  run: async (ctx) => {
    const agent = (ctx.values["agent"] as string | undefined) ?? "default";
    const name = ctx.values["name"] as string | undefined;
    const metadata = parseJsonValue("metadata", ctx.values["metadata"] as string | undefined);

    const result = await requestJson(ctx, {
      method: "POST",
      path: "/sessions",
      body: {
        agent,
        name,
        metadata,
      },
    });

    printJson(result);
  },
});

const sessionsGetCommand = define({
  name: "get",
  description: "Get a session",
  args: {
    ...baseArgs,
    id: {
      type: "string",
      short: "i",
      description: "Session ID",
      required: true,
    },
  },
  run: async (ctx) => {
    const id = ctx.values["id"] as string;
    const result = await requestJson(ctx, {
      method: "GET",
      path: `/sessions/${id}`,
    });
    printJson(result);
  },
});

const sessionsSendEventCommand = define({
  name: "send-event",
  description: "Send an event to a session",
  args: {
    ...baseArgs,
    id: {
      type: "string",
      short: "i",
      description: "Session ID",
      required: true,
    },
    type: {
      type: "string",
      short: "t",
      description: "Event type (default: user_message)",
    },
    payload: {
      type: "string",
      description: "JSON payload",
    },
  },
  run: async (ctx) => {
    const id = ctx.values["id"] as string;
    const type = (ctx.values["type"] as string | undefined) ?? "user_message";
    const payload = parseJsonValue("payload", ctx.values["payload"] as string | undefined);

    const result = await requestJson(ctx, {
      method: "POST",
      path: `/sessions/${id}/events`,
      body: {
        type,
        payload,
      },
    });

    printJson(result);
  },
});

const sessionsSubCommands: Map<string, Command<Args>> = new Map();
sessionsSubCommands.set("list", sessionsListCommand as Command<Args>);
sessionsSubCommands.set("create", sessionsCreateCommand as Command<Args>);
sessionsSubCommands.set("get", sessionsGetCommand as Command<Args>);
sessionsSubCommands.set("send-event", sessionsSendEventCommand as Command<Args>);

const printMainHelp = () => {
  console.log("Workflow usage fragment CLI");
  console.log("");
  console.log("USAGE:");
  console.log("  workflow-usage <COMMAND>");
  console.log("");
  console.log("COMMANDS:");
  console.log("  sessions              Manage sessions");
  console.log("");
  console.log("GLOBAL OPTIONS:");
  console.log(
    "  -b, --base-url         Base URL (default: http://127.0.0.1:4100/api/workflow-usage-fragment)",
  );
  console.log("  -H, --header           Extra HTTP header (repeatable)");
  console.log("");
  console.log("ENVIRONMENT:");
  console.log("  WORKFLOW_USAGE_BASE_URL  Base URL (or BASE_URL)");
  console.log("");
  console.log("EXAMPLES:");
  console.log("  workflow-usage sessions list");
  console.log("  workflow-usage sessions create --agent default");
  console.log("  workflow-usage sessions get --id <sessionId>");
  console.log(
    '  workflow-usage sessions send-event --id <sessionId> --type user_message --payload \'{"text":"hi"}\'',
  );
};

const printSessionsHelp = () => {
  console.log("Session commands");
  console.log("");
  console.log("USAGE:");
  console.log("  workflow-usage sessions <COMMAND>");
  console.log("");
  console.log("COMMANDS:");
  console.log("  list                   List sessions");
  console.log("  create                 Create a session");
  console.log("  get                    Get a session");
  console.log("  send-event             Send an event to a session");
};

export async function run() {
  try {
    const args = process.argv.slice(2);

    if (!args.length || args[0] === "--help" || args[0] === "-h") {
      printMainHelp();
      return;
    }

    if (args[0] === "--version" || args[0] === "-v") {
      console.log(version);
      return;
    }

    if (args[0] === "sessions") {
      const subCommandName = args[1];
      if (!subCommandName || subCommandName === "--help" || subCommandName === "-h") {
        printSessionsHelp();
        return;
      }
      if (subCommandName === "--version" || subCommandName === "-v") {
        console.log(version);
        return;
      }

      const subCommand = sessionsSubCommands.get(subCommandName);
      if (!subCommand) {
        console.error(`Unknown command: ${subCommandName}`);
        console.log("");
        console.log("Run 'workflow-usage sessions --help' for available commands.");
        process.exit(1);
      }

      await cli(args.slice(2), subCommand, {
        name: `workflow-usage sessions ${subCommandName}`,
        version,
      });
      return;
    }

    console.error(`Unknown command: ${args[0]}`);
    console.log("");
    console.log("Run 'workflow-usage --help' for available commands.");
    process.exit(1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (import.meta.main) {
  await run();
}

export { sessionsListCommand, sessionsCreateCommand, sessionsGetCommand, sessionsSendEventCommand };
