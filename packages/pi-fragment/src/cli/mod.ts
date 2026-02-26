import { readFile } from "node:fs/promises";

import { resolveConfig, type ResolvedCliConfig } from "./config";
import { createHttpClient } from "./http/client";
import { renderOutput, type RenderOutput } from "./render";

export type CliActionResult = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  output?: RenderOutput;
};

export type SessionsListArgs = {
  limit?: number;
};

export type SessionsCreateArgs = {
  agent: string;
  name?: string;
  tags?: string[];
  metadata?: unknown;
  steeringMode?: "all" | "one-at-a-time";
};

export type SessionsGetArgs = {
  sessionId: string;
  statusOnly?: boolean;
};

export type SessionsSendMessageArgs = {
  sessionId: string;
  text?: string;
  file?: string;
  done?: boolean;
  steeringMode?: "all" | "one-at-a-time";
};

export type CliContext = {
  config: ResolvedCliConfig;
  logger: Pick<Console, "log" | "error">;
};

export type CliActions = {
  sessionsList: (
    args: SessionsListArgs,
    ctx: CliContext,
  ) => Promise<CliActionResult | void> | CliActionResult | void;
  sessionsCreate: (
    args: SessionsCreateArgs,
    ctx: CliContext,
  ) => Promise<CliActionResult | void> | CliActionResult | void;
  sessionsGet: (
    args: SessionsGetArgs,
    ctx: CliContext,
  ) => Promise<CliActionResult | void> | CliActionResult | void;
  sessionsSendMessage: (
    args: SessionsSendMessageArgs,
    ctx: CliContext,
  ) => Promise<CliActionResult | void> | CliActionResult | void;
};

export type RunOptions = {
  logger?: Pick<Console, "log" | "error">;
  actions?: CliActions;
};

const USAGE = `fragno-pi <command> [options]

Commands:
  sessions list           List pi-fragment sessions
  sessions create         Create a pi-fragment session
  sessions get            Fetch session detail/status
  sessions send-message   Send a user message to a session

Global options:
  -b, --base-url <url>        Fragment base URL (FRAGNO_PI_BASE_URL)
  -H, --header <header>       Extra HTTP header (repeatable)
  --timeout <ms>              Request timeout in ms (default: 15000)
  --retries <n>               Retry count (default: 2)
  --retry-delay <ms>          Delay between retries (default: 500)
  --json                      Output raw JSON
  --debug                     Log request metadata to stderr
  -h, --help                  Show this help message

sessions list:
  --limit <n>                 Limit results (default server: 50)

sessions create:
  --agent <name>              Agent name (required)
  --name <label>              Session label
  --tag <tag>                 Tag (repeatable)
  --metadata <json>           Metadata JSON string
  --steering-mode <mode>      all|one-at-a-time

sessions get:
  -s, --session <id>          Session id (or positional)
  --status-only               Only output status fields

sessions send-message:
  -s, --session <id>          Session id (or positional)
  --text <message>            Message text
  --file <path>               Read message text from file
  --done                      Mark session done
  --steering-mode <mode>      all|one-at-a-time`;

const buildErrorResult = (message: string, usage = USAGE): CliActionResult => ({
  stderr: `${message}\n\n${usage}`,
  exitCode: 1,
});

const requireBaseUrl = (config: ResolvedCliConfig): CliActionResult | null => {
  if (config.baseUrl) {
    return null;
  }
  return buildErrorResult("Missing required option: --base-url (or FRAGNO_PI_BASE_URL)");
};

const debugLog = (
  config: ResolvedCliConfig,
  logger: Pick<Console, "log" | "error"> | undefined,
  message: string,
) => {
  if (!config.debug) {
    return;
  }
  if (logger?.error) {
    logger.error(message);
    return;
  }
  console.error(message);
};

const readResponseBody = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const formatErrorMessage = (status: number, body: unknown): string => {
  if (body && typeof body === "object" && "message" in body) {
    const message = (body as { message?: string }).message;
    if (message) {
      return `Request failed (${status}): ${message}`;
    }
  }
  if (typeof body === "string" && body.trim()) {
    return `Request failed (${status}): ${body}`;
  }
  return `Request failed (${status}).`;
};

const buildClient = (config: ResolvedCliConfig) =>
  createHttpClient({
    baseUrl: config.baseUrl ?? "",
    headers: config.headers,
    timeoutMs: config.timeoutMs,
    retries: config.retries,
    retryDelayMs: config.retryDelayMs,
  });

const requestJson = async (
  config: ResolvedCliConfig,
  logger: Pick<Console, "log" | "error"> | undefined,
  options: { method: string; path: string; body?: unknown },
): Promise<{ ok: true; data: unknown } | { ok: false; error: CliActionResult }> => {
  const baseError = requireBaseUrl(config);
  if (baseError) {
    return { ok: false, error: baseError };
  }

  const client = buildClient(config);
  debugLog(config, logger, `request ${options.method} ${options.path}`);

  try {
    const response = await client.request({
      method: options.method,
      path: options.path,
      body: options.body,
    });

    const body = await readResponseBody(response);
    debugLog(config, logger, `response ${response.status} ${options.method} ${options.path}`);

    if (!response.ok) {
      return {
        ok: false,
        error: { stderr: formatErrorMessage(response.status, body), exitCode: 2 },
      };
    }

    return { ok: true, data: body };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { stderr: message, exitCode: 2 } };
  }
};

const getRecordValue = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  return value === null || value === undefined ? "" : String(value);
};

const buildSessionsListOutput = (data: unknown, json: boolean): CliActionResult => {
  if (!Array.isArray(data)) {
    return { stderr: "Unexpected response for sessions list.", exitCode: 2 };
  }

  if (json) {
    return { output: { format: "json", data } };
  }

  const rows = data.map((session) => {
    if (session && typeof session === "object") {
      const record = session as Record<string, unknown>;
      return {
        id: getRecordValue(record, "id"),
        agent: getRecordValue(record, "agent"),
        name: getRecordValue(record, "name"),
        status: getRecordValue(record, "status"),
        updated: getRecordValue(record, "updatedAt"),
      };
    }
    return { id: "", agent: "", name: "", status: "", updated: "" };
  });

  return {
    output: {
      format: "table",
      columns: [
        { key: "id", label: "ID" },
        { key: "agent", label: "Agent" },
        { key: "name", label: "Name" },
        { key: "status", label: "Status" },
        { key: "updated", label: "Updated" },
      ],
      rows,
    },
  };
};

const buildDetailOutput = (data: unknown, json: boolean): CliActionResult => {
  if (json) {
    return { output: { format: "json", data } };
  }
  return { output: { format: "pretty-json", data } };
};

const buildSendMessageOutput = (data: unknown, json: boolean): CliActionResult => {
  if (json) {
    return { output: { format: "json", data } };
  }

  if (!data || typeof data !== "object") {
    return { output: { format: "pretty-json", data } };
  }

  const record = data as Record<string, unknown>;
  const status = record["status"];
  const assistant = record["assistant"];
  const hasAssistant = assistant !== undefined && assistant !== null;

  const lines: string[] = [];
  if (status !== undefined) {
    lines.push(`Status: ${String(status)}`);
  }
  if (hasAssistant) {
    const assistantText =
      typeof assistant === "string" ? assistant : JSON.stringify(assistant, null, 2);
    lines.push(assistantText);
  } else if (status !== undefined) {
    lines.push("Message accepted. Use `sessions get` to fetch the response.");
  }

  if (lines.length === 0) {
    return { output: { format: "pretty-json", data } };
  }

  return { output: { format: "text", text: lines.join("\n\n") } };
};

const resolveMessageText = async (
  args: SessionsSendMessageArgs,
): Promise<{ ok: true; text: string } | { ok: false; error: CliActionResult }> => {
  if (args.text) {
    return { ok: true, text: args.text };
  }
  if (!args.file) {
    return {
      ok: false,
      error: buildErrorResult("Missing required option: --text (or --file)"),
    };
  }
  try {
    const text = await readFile(args.file, "utf8");
    return { ok: true, text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: buildErrorResult(`Unable to read --file ${args.file}: ${message}`),
    };
  }
};

const defaultActions: CliActions = {
  sessionsList: async (args, ctx) => {
    const query = new URLSearchParams();
    if (args.limit !== undefined) {
      query.set("limit", String(args.limit));
    }
    const path = query.size ? `/sessions?${query.toString()}` : "/sessions";
    const response = await requestJson(ctx.config, ctx.logger, { method: "GET", path });
    if (!response.ok) {
      return response.error;
    }
    return buildSessionsListOutput(response.data, ctx.config.json);
  },
  sessionsCreate: async (args, ctx) => {
    const body: Record<string, unknown> = { agent: args.agent };
    if (args.name) {
      body["name"] = args.name;
    }
    if (args.tags && args.tags.length > 0) {
      body["tags"] = args.tags;
    }
    if (args.metadata !== undefined) {
      body["metadata"] = args.metadata;
    }
    if (args.steeringMode) {
      body["steeringMode"] = args.steeringMode;
    }

    const response = await requestJson(ctx.config, ctx.logger, {
      method: "POST",
      path: "/sessions",
      body,
    });
    if (!response.ok) {
      return response.error;
    }
    return buildDetailOutput(response.data, ctx.config.json);
  },
  sessionsGet: async (args, ctx) => {
    const path = `/sessions/${encodeURIComponent(args.sessionId)}`;
    const response = await requestJson(ctx.config, ctx.logger, { method: "GET", path });
    if (!response.ok) {
      return response.error;
    }
    const data = response.data;
    const outputData =
      args.statusOnly && data && typeof data === "object"
        ? {
            status: (data as Record<string, unknown>)["status"],
            workflow: (data as Record<string, unknown>)["workflow"],
            summaries: (data as Record<string, unknown>)["summaries"],
          }
        : data;
    return buildDetailOutput(outputData, ctx.config.json);
  },
  sessionsSendMessage: async (args, ctx) => {
    const resolved = await resolveMessageText(args);
    if (!resolved.ok) {
      return resolved.error;
    }
    const body: Record<string, unknown> = { text: resolved.text };
    if (args.done) {
      body["done"] = true;
    }
    if (args.steeringMode) {
      body["steeringMode"] = args.steeringMode;
    }
    const path = `/sessions/${encodeURIComponent(args.sessionId)}/messages`;
    const response = await requestJson(ctx.config, ctx.logger, { method: "POST", path, body });
    if (!response.ok) {
      return response.error;
    }
    return buildSendMessageOutput(response.data, ctx.config.json);
  },
};

type ParsedArgs = {
  command?: string;
  action?: string;
  options: Record<string, string | boolean | string[]>;
  positionals: string[];
  help: boolean;
  errors: string[];
};

const VALUE_OPTIONS = new Set([
  "base-url",
  "header",
  "timeout",
  "retries",
  "retry-delay",
  "limit",
  "agent",
  "name",
  "tag",
  "metadata",
  "steering-mode",
  "session",
  "text",
  "file",
]);

const SHORT_OPTIONS: Record<string, string> = {
  "-b": "base-url",
  "-H": "header",
  "-s": "session",
};

const ALL_LONG_OPTIONS = new Set([...VALUE_OPTIONS, "json", "debug", "status-only", "done"]);

const ALL_SHORT_OPTIONS = new Set(Object.keys(SHORT_OPTIONS));

const editDistance = (left: string, right: string): number => {
  const leftLen = left.length;
  const rightLen = right.length;
  const dp: number[] = Array.from({ length: rightLen + 1 }, (_, index) => index);

  for (let i = 1; i <= leftLen; i += 1) {
    let prev = dp[0] ?? 0;
    dp[0] = i;
    const leftChar = left[i - 1];
    for (let j = 1; j <= rightLen; j += 1) {
      const temp = dp[j] ?? 0;
      const cost = leftChar === right[j - 1] ? 0 : 1;
      dp[j] = Math.min((dp[j] ?? 0) + 1, (dp[j - 1] ?? 0) + 1, prev + cost);
      prev = temp;
    }
  }

  return dp[rightLen] ?? Math.max(leftLen, rightLen);
};

const suggestLongOption = (key: string): string | null => {
  let best: { key: string; score: number } | null = null;
  for (const candidate of ALL_LONG_OPTIONS) {
    const score = editDistance(key, candidate);
    if (!best || score < best.score) {
      best = { key: candidate, score };
    }
  }
  if (best && best.score <= 3) {
    return best.key;
  }
  return null;
};

const addOption = (
  options: Record<string, string | boolean | string[]>,
  key: string,
  value: string | boolean,
) => {
  if (typeof value === "boolean") {
    options[key] = value;
    return;
  }

  const current = options[key];
  if (!current) {
    options[key] = value;
    return;
  }
  if (Array.isArray(current)) {
    current.push(value);
    return;
  }
  options[key] = [String(current), value];
};

const coerceBooleanValue = (value: string): boolean | string => {
  const normalized = value.trim().toLowerCase();
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  return value;
};

const parseArgs = (argv: string[]): ParsedArgs => {
  const options: Record<string, string | boolean | string[]> = {};
  const positionals: string[] = [];
  const errors: string[] = [];
  let help = false;
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      const [rawKey, rawValue] = arg.split("=", 2);
      const key = rawKey.slice(2);
      if (!ALL_LONG_OPTIONS.has(key)) {
        const suggestion = suggestLongOption(key);
        errors.push(
          `Unknown option: --${key}${suggestion ? ` (did you mean --${suggestion}?)` : ""}`,
        );
        if (rawValue !== undefined) {
          i += 1;
          continue;
        }
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }
      if (rawValue !== undefined) {
        const normalizedValue = VALUE_OPTIONS.has(key) ? rawValue : coerceBooleanValue(rawValue);
        addOption(options, key, normalizedValue);
        i += 1;
        continue;
      }
      if (VALUE_OPTIONS.has(key)) {
        const next = argv[i + 1];
        if (!next || next.startsWith("-")) {
          errors.push(`Missing value for --${key}`);
          i += 1;
          continue;
        }
        addOption(options, key, next);
        i += 2;
        continue;
      }
      addOption(options, key, true);
      i += 1;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      if (arg === "-h") {
        help = true;
        i += 1;
        continue;
      }
      if (!ALL_SHORT_OPTIONS.has(arg)) {
        errors.push(`Unknown option: ${arg}`);
        i += 1;
        continue;
      }
      const key = SHORT_OPTIONS[arg];
      if (key) {
        const next = argv[i + 1];
        if (!next || next.startsWith("-")) {
          errors.push(`Missing value for ${arg}`);
          i += 1;
          continue;
        }
        addOption(options, key, next);
        i += 2;
        continue;
      }
      positionals.push(arg);
      i += 1;
      continue;
    }
    positionals.push(arg);
    i += 1;
  }

  const [command, action, ...rest] = positionals;

  return { command, action, options, positionals: rest, help, errors };
};

const getStringOption = (
  options: Record<string, string | boolean | string[]>,
  key: string,
): string | undefined => {
  const value = options[key];
  if (Array.isArray(value)) {
    return value[0];
  }
  if (typeof value === "string") {
    return value;
  }
  return undefined;
};

const getStringArrayOption = (
  options: Record<string, string | boolean | string[]>,
  key: string,
): string[] | undefined => {
  const value = options[key];
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value === "string") {
    return [value];
  }
  return undefined;
};

const getBooleanOption = (
  options: Record<string, string | boolean | string[]>,
  key: string,
): boolean => Boolean(options[key]);

const parseNumberOption = (
  options: Record<string, string | boolean | string[]>,
  key: string,
): number | undefined => {
  const value = getStringOption(options, key);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid value for --${key}`);
  }
  return parsed;
};

const parseSteeringMode = (value?: string): "all" | "one-at-a-time" | undefined => {
  if (!value) {
    return undefined;
  }
  if (value === "all" || value === "one-at-a-time") {
    return value;
  }
  throw new Error("Invalid --steering-mode. Expected: all|one-at-a-time");
};

const resolveRunOptions = (
  loggerOrOptions?: Pick<Console, "log" | "error"> | RunOptions,
): RunOptions => {
  if (!loggerOrOptions) {
    return {};
  }
  if ("log" in loggerOrOptions) {
    return { logger: loggerOrOptions };
  }
  return loggerOrOptions;
};

const buildConfig = (options: Record<string, string | boolean | string[]>): ResolvedCliConfig => {
  return resolveConfig({
    baseUrl: getStringOption(options, "base-url"),
    headers: getStringArrayOption(options, "header"),
    timeoutMs: getStringOption(options, "timeout"),
    retries: getStringOption(options, "retries"),
    retryDelayMs: getStringOption(options, "retry-delay"),
    json: getBooleanOption(options, "json"),
    debug: getBooleanOption(options, "debug"),
  });
};

const renderResult = (
  result: CliActionResult | void,
  config: ResolvedCliConfig,
): CliActionResult => {
  if (!result) {
    return {};
  }
  if (!result.stdout && result.output) {
    return { ...result, stdout: renderOutput(result.output, config.json) };
  }
  return result;
};

export async function run(
  argv: string[],
  loggerOrOptions: Pick<Console, "log" | "error"> | RunOptions = console,
): Promise<number> {
  const options = resolveRunOptions(loggerOrOptions);
  const logger = options.logger ?? console;
  const actions = options.actions ?? defaultActions;

  const parsed = parseArgs(argv.slice(2));

  if (parsed.errors.length > 0) {
    const result = buildErrorResult(parsed.errors.join("\n"));
    logger.error(result.stderr ?? "");
    return result.exitCode ?? 1;
  }

  if (parsed.help || !parsed.command || parsed.command === "help") {
    logger.log(USAGE);
    return parsed.command && !parsed.help ? 1 : 0;
  }

  let config: ResolvedCliConfig;
  try {
    config = buildConfig(parsed.options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result = buildErrorResult(message);
    logger.error(result.stderr ?? "");
    return result.exitCode ?? 1;
  }

  const ctx: CliContext = { config, logger };
  const command = parsed.command;
  const action = parsed.action;
  const opts = parsed.options;

  try {
    let result: CliActionResult | void;
    switch (command) {
      case "sessions": {
        if (!action) {
          result = buildErrorResult("Missing sessions action.");
          break;
        }
        switch (action) {
          case "list": {
            const limit = parseNumberOption(opts, "limit");
            result = await actions.sessionsList({ limit }, ctx);
            break;
          }
          case "create": {
            const agent = getStringOption(opts, "agent");
            if (!agent) {
              result = buildErrorResult("Missing required option: --agent");
              break;
            }
            const steeringMode = parseSteeringMode(getStringOption(opts, "steering-mode"));
            const metadataRaw = getStringOption(opts, "metadata");
            let metadata: unknown;
            if (metadataRaw) {
              try {
                metadata = JSON.parse(metadataRaw);
              } catch {
                result = buildErrorResult("Invalid JSON for --metadata");
                break;
              }
            }
            result = await actions.sessionsCreate(
              {
                agent,
                name: getStringOption(opts, "name"),
                tags: getStringArrayOption(opts, "tag"),
                metadata,
                steeringMode,
              },
              ctx,
            );
            break;
          }
          case "get": {
            const sessionId = getStringOption(opts, "session") ?? parsed.positionals[0];
            if (!sessionId) {
              result = buildErrorResult("Missing required option: --session");
              break;
            }
            result = await actions.sessionsGet(
              { sessionId, statusOnly: getBooleanOption(opts, "status-only") },
              ctx,
            );
            break;
          }
          case "send-message": {
            const sessionId = getStringOption(opts, "session") ?? parsed.positionals[0];
            if (!sessionId) {
              result = buildErrorResult("Missing required option: --session");
              break;
            }
            const steeringMode = parseSteeringMode(getStringOption(opts, "steering-mode"));
            const text = getStringOption(opts, "text");
            const file = getStringOption(opts, "file");
            if (!text && !file) {
              result = buildErrorResult("Missing required option: --text (or --file)");
              break;
            }
            result = await actions.sessionsSendMessage(
              { sessionId, text, file, done: getBooleanOption(opts, "done"), steeringMode },
              ctx,
            );
            break;
          }
          default: {
            result = buildErrorResult(`Unknown sessions action: ${action}`);
            break;
          }
        }
        break;
      }
      default: {
        result = buildErrorResult(`Unknown command: ${command}`);
        break;
      }
    }

    const resolved = renderResult(result, config);
    if (resolved.stdout) {
      logger.log(resolved.stdout);
    }
    if (resolved.stderr) {
      logger.error(resolved.stderr);
    }
    if (typeof resolved.exitCode === "number") {
      return resolved.exitCode;
    }
    return resolved.stderr ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`${message}\n\n${USAGE}`);
    return 1;
  }
}

export const __testing = { USAGE, parseArgs, renderOutput };
