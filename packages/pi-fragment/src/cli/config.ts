export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_RETRIES = 2;
export const DEFAULT_RETRY_DELAY_MS = 500;

export type CliConfigInput = {
  baseUrl?: string;
  headers?: string[];
  timeoutMs?: number | string;
  retries?: number | string;
  retryDelayMs?: number | string;
  json?: boolean;
  debug?: boolean;
  env?: NodeJS.ProcessEnv;
};

export type ResolvedCliConfig = {
  baseUrl?: string;
  headers: Record<string, string>;
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
  json: boolean;
  debug: boolean;
};

const parseNumber = (
  value: number | string | undefined,
  label: string,
  minimum = 0,
): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`${label} must be a number`);
  }
  if (numeric < minimum) {
    throw new Error(`${label} must be at least ${minimum}`);
  }
  return numeric;
};

const parseInteger = (
  value: number | string | undefined,
  label: string,
  minimum = 0,
): number | undefined => {
  const numeric = parseNumber(value, label, minimum);
  if (numeric === undefined) {
    return undefined;
  }
  return Number.isInteger(numeric) ? numeric : Math.floor(numeric);
};

const parseHeaderLine = (value: string, source: string): [string, string] => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${source} header value cannot be empty`);
  }
  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex === -1) {
    throw new Error(`${source} header must be in the form "Key: Value"`);
  }
  const key = trimmed.slice(0, separatorIndex).trim();
  const headerValue = trimmed.slice(separatorIndex + 1).trim();
  if (!key || !headerValue) {
    throw new Error(`${source} header must include both key and value`);
  }
  return [key, headerValue];
};

const parseHeaderList = (values: string[], source: string): Record<string, string> => {
  return values.reduce<Record<string, string>>((acc, value) => {
    const [key, headerValue] = parseHeaderLine(value, source);
    acc[key] = headerValue;
    return acc;
  }, {});
};

export const parseEnvHeaders = (value?: string): Record<string, string> => {
  if (!value) {
    return {};
  }
  const entries = value
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return parseHeaderList(entries, "FRAGNO_PI_HEADERS");
};

export const parseFlagHeaders = (values?: string[]): Record<string, string> => {
  if (!values || values.length === 0) {
    return {};
  }
  return parseHeaderList(values, "-H/--header");
};

export const resolveConfig = (input: CliConfigInput = {}): ResolvedCliConfig => {
  const env = input.env ?? process.env;

  const baseUrl = input.baseUrl ?? env["FRAGNO_PI_BASE_URL"];
  const timeoutMs =
    parseNumber(input.timeoutMs, "timeout", 1) ??
    parseNumber(env["FRAGNO_PI_TIMEOUT_MS"], "FRAGNO_PI_TIMEOUT_MS", 1) ??
    DEFAULT_TIMEOUT_MS;
  const retries =
    parseInteger(input.retries, "retries", 0) ??
    parseInteger(env["FRAGNO_PI_RETRIES"], "FRAGNO_PI_RETRIES", 0) ??
    DEFAULT_RETRIES;
  const retryDelayMs =
    parseNumber(input.retryDelayMs, "retry delay", 0) ??
    parseNumber(env["FRAGNO_PI_RETRY_DELAY_MS"], "FRAGNO_PI_RETRY_DELAY_MS", 0) ??
    DEFAULT_RETRY_DELAY_MS;

  const headers = {
    ...parseEnvHeaders(env["FRAGNO_PI_HEADERS"]),
    ...parseFlagHeaders(input.headers),
  };

  return {
    baseUrl,
    headers,
    timeoutMs,
    retries,
    retryDelayMs,
    json: Boolean(input.json),
    debug: Boolean(input.debug),
  };
};
