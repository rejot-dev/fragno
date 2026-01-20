import { createClient, type ClientConfig } from "./client.js";

type CommandContext = { values: Record<string, unknown> };

export const baseArgs = {
  "base-url": {
    type: "string",
    short: "b",
    description: "AI fragment base URL (env: FRAGNO_AI_BASE_URL)",
  },
  header: {
    type: "string",
    short: "H",
    description: "Extra HTTP header (repeatable), format: 'Name: value' (env: FRAGNO_AI_HEADERS)",
    multiple: true,
  },
  timeout: {
    type: "number",
    description: "Request timeout in ms (env: FRAGNO_AI_TIMEOUT_MS, default: 15000)",
  },
  retries: {
    type: "number",
    description: "Retry count for network/5xx/429 (env: FRAGNO_AI_RETRIES, default: 2)",
  },
  "retry-delay": {
    type: "number",
    description: "Delay between retries in ms (env: FRAGNO_AI_RETRY_DELAY_MS, default: 500)",
  },
} as const;

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 500;

const parseNumberEnv = (value: string | undefined) => {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return parsed;
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

const parseEnvHeaders = () => {
  const envHeaders = process.env["FRAGNO_AI_HEADERS"];
  if (!envHeaders) {
    return [];
  }
  return envHeaders
    .split(/\n|;/)
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const buildHeaders = (values: string[]) => {
  const headers = new Headers();
  for (const value of values) {
    const index = value.indexOf(":");
    if (index === -1) {
      throw new Error(`Invalid header: ${value}`);
    }
    const name = value.slice(0, index).trim();
    const headerValue = value.slice(index + 1).trim();
    if (!name || !headerValue) {
      throw new Error(`Invalid header: ${value}`);
    }
    headers.append(name, headerValue);
  }
  return headers;
};

const resolveTimeout = (ctx: CommandContext) =>
  (ctx.values["timeout"] as number | undefined) ??
  parseNumberEnv(process.env["FRAGNO_AI_TIMEOUT_MS"]) ??
  DEFAULT_TIMEOUT_MS;

const resolveRetries = (ctx: CommandContext) =>
  (ctx.values["retries"] as number | undefined) ??
  parseNumberEnv(process.env["FRAGNO_AI_RETRIES"]) ??
  DEFAULT_RETRIES;

const resolveRetryDelay = (ctx: CommandContext) =>
  (ctx.values["retry-delay"] as number | undefined) ??
  parseNumberEnv(process.env["FRAGNO_AI_RETRY_DELAY_MS"]) ??
  DEFAULT_RETRY_DELAY_MS;

export const resolveBaseUrl = (ctx: CommandContext) => {
  const baseUrl =
    (ctx.values["base-url"] as string | undefined) ?? process.env["FRAGNO_AI_BASE_URL"];
  if (!baseUrl) {
    throw new Error("Missing base URL. Provide --base-url or set FRAGNO_AI_BASE_URL.");
  }
  return baseUrl.replace(/\/$/, "");
};

export const createClientFromContext = (ctx: CommandContext) => {
  const headerValues = normalizeHeaderValues(ctx.values["header"]).concat(parseEnvHeaders());

  const clientConfig: ClientConfig = {
    baseUrl: resolveBaseUrl(ctx),
    headers: buildHeaders(headerValues),
    timeoutMs: resolveTimeout(ctx),
    retries: resolveRetries(ctx),
    retryDelayMs: resolveRetryDelay(ctx),
  };

  return createClient(clientConfig);
};

export const parseJsonValue = (label: string, value: string | undefined) => {
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
