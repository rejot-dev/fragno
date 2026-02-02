import { encodeFileKey, encodeFileKeyPrefix, type FileKeyParts } from "../../keys.js";
import { createClient, type ClientConfig } from "./client.js";

type CommandContext = { values: Record<string, unknown> };

export const baseArgs = {
  "base-url": {
    type: "string",
    short: "b",
    description: "Upload fragment base URL (env: FRAGNO_UPLOAD_BASE_URL)",
  },
  header: {
    type: "string",
    short: "H",
    description:
      "Extra HTTP header (repeatable), format: 'Name: value' (env: FRAGNO_UPLOAD_HEADERS)",
    multiple: true,
  },
  timeout: {
    type: "number",
    description: "Request timeout in ms (env: FRAGNO_UPLOAD_TIMEOUT_MS, default: 15000)",
  },
  retries: {
    type: "number",
    description: "Retry count for network/5xx/429 (env: FRAGNO_UPLOAD_RETRIES, default: 2)",
  },
  "retry-delay": {
    type: "number",
    description: "Delay between retries in ms (env: FRAGNO_UPLOAD_RETRY_DELAY_MS, default: 500)",
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
  const envHeaders = process.env["FRAGNO_UPLOAD_HEADERS"];
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
  parseNumberEnv(process.env["FRAGNO_UPLOAD_TIMEOUT_MS"]) ??
  DEFAULT_TIMEOUT_MS;

const resolveRetries = (ctx: CommandContext) =>
  (ctx.values["retries"] as number | undefined) ??
  parseNumberEnv(process.env["FRAGNO_UPLOAD_RETRIES"]) ??
  DEFAULT_RETRIES;

const resolveRetryDelay = (ctx: CommandContext) =>
  (ctx.values["retry-delay"] as number | undefined) ??
  parseNumberEnv(process.env["FRAGNO_UPLOAD_RETRY_DELAY_MS"]) ??
  DEFAULT_RETRY_DELAY_MS;

export const resolveBaseUrl = (ctx: CommandContext) => {
  const baseUrl =
    (ctx.values["base-url"] as string | undefined) ?? process.env["FRAGNO_UPLOAD_BASE_URL"];
  if (!baseUrl) {
    throw new Error("Missing base URL. Provide --base-url or set FRAGNO_UPLOAD_BASE_URL.");
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
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label} JSON: ${message}`);
  }
};

export const parseFileKeyParts = (label: string, value: string | undefined): FileKeyParts => {
  const parsed = parseJsonValue(label, value);
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array`);
  }
  for (const part of parsed) {
    if (typeof part !== "string" && typeof part !== "number") {
      throw new Error(`${label} must contain only strings or numbers`);
    }
  }
  return parsed as FileKeyParts;
};

export const resolveFileKeyValue = (input: {
  fileKey: string | undefined;
  keyParts: string | undefined;
}) => {
  if (input.fileKey && input.keyParts) {
    throw new Error("Provide either --file-key or --key-parts, not both.");
  }

  if (input.fileKey) {
    return { fileKey: input.fileKey, keyParts: undefined };
  }

  if (input.keyParts) {
    const parts = parseFileKeyParts("key-parts", input.keyParts);
    return { fileKey: encodeFileKey(parts), keyParts: parts };
  }

  throw new Error("Missing file key. Provide --file-key or --key-parts.");
};

export const resolveOptionalFileKeyValue = (input: {
  fileKey: string | undefined;
  keyParts: string | undefined;
}) => {
  if (input.fileKey && input.keyParts) {
    throw new Error("Provide either --file-key or --key-parts, not both.");
  }

  if (input.fileKey) {
    return { fileKey: input.fileKey, keyParts: undefined };
  }

  if (input.keyParts) {
    const parts = parseFileKeyParts("key-parts", input.keyParts);
    return { fileKey: encodeFileKey(parts), keyParts: parts };
  }

  return { fileKey: undefined, keyParts: undefined };
};

export const resolvePrefixValue = (input: {
  prefix: string | undefined;
  prefixParts: string | undefined;
}) => {
  if (input.prefix && input.prefixParts) {
    throw new Error("Provide either --prefix or --prefix-parts, not both.");
  }

  if (input.prefix) {
    return input.prefix;
  }

  if (input.prefixParts) {
    const parts = parseFileKeyParts("prefix-parts", input.prefixParts);
    return encodeFileKeyPrefix(parts);
  }

  return undefined;
};
