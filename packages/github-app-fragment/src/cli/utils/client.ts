import { Readable } from "node:stream";

export type ClientConfig = {
  baseUrl: string;
  headers?: HeadersInit;
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
};

type RequestOptions = {
  path: string;
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: BodyInit | null | unknown;
  json?: boolean;
  headers?: HeadersInit;
  retry?: boolean;
};

type JsonRequestOptions = Omit<RequestOptions, "body" | "json"> & { body?: unknown };

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const buildUrl = (
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
) => {
  const base = new URL(baseUrl);
  const basePath = base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname;
  const pathPart = path.startsWith("/") ? path : `/${path}`;
  base.pathname = `${basePath}${pathPart}`;

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) {
        continue;
      }
      base.searchParams.set(key, String(value));
    }
  }

  return base.toString();
};

const shouldRetry = (response: Response) => {
  if (response.status >= 500) {
    return true;
  }
  return response.status === 429;
};

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  config: Pick<ClientConfig, "timeoutMs" | "retries" | "retryDelayMs">,
) {
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= config.retries) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok && shouldRetry(response) && attempt < config.retries) {
        attempt += 1;
        await delay(config.retryDelayMs);
        continue;
      }

      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;
      if (attempt >= config.retries) {
        throw error;
      }
      attempt += 1;
      await delay(config.retryDelayMs);
    }
  }

  throw lastError ?? new Error("Request failed");
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

const safeJsonParse = (text: string) => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

const readErrorPayload = async (response: Response) => {
  const text = await response.text();
  const parsed = text ? safeJsonParse(text) : undefined;
  const errorPayload = parsed as { message?: string; code?: string } | undefined;
  return {
    text,
    parsed,
    message: errorPayload?.message ?? text ?? response.statusText,
    code: errorPayload?.code,
  };
};

async function requestResponse(config: ClientConfig, options: RequestOptions): Promise<Response> {
  const url = buildUrl(config.baseUrl, options.path, options.query);
  const mergedHeaders = new Headers(config.headers ?? {});

  if (options.headers) {
    const extra = new Headers(options.headers);
    for (const [key, value] of extra.entries()) {
      mergedHeaders.set(key, value);
    }
  }

  let payload: BodyInit | undefined;

  if (options.json && options.body !== undefined) {
    mergedHeaders.set("content-type", "application/json");
    payload = JSON.stringify(options.body);
  } else {
    payload = options.body as BodyInit | undefined;
  }

  const init: RequestInit & { duplex?: "half" } = {
    method: options.method ?? "GET",
    headers: mergedHeaders,
    body: payload,
  };

  if (
    payload &&
    typeof payload === "object" &&
    (payload instanceof Readable || "getReader" in (payload as object))
  ) {
    init.duplex = "half";
  }

  const shouldRetryRequest = options.retry !== false;
  const response = shouldRetryRequest
    ? await fetchWithRetry(url, init, config)
    : await fetchWithTimeout(url, init, config.timeoutMs);

  if (!response.ok) {
    const { message, code } = await readErrorPayload(response);
    const error = new Error(
      `Request failed: ${response.status} ${message}${code ? ` (${code})` : ""}`,
    ) as Error & { code?: string };
    if (code) {
      error.code = code;
    }
    throw error;
  }

  return response;
}

async function requestJson<T>(config: ClientConfig, options: JsonRequestOptions): Promise<T> {
  const response = await requestResponse(config, { ...options, json: true });
  const text = await response.text();
  const parsed = text ? safeJsonParse(text) : undefined;

  if (parsed === undefined) {
    return undefined as T;
  }

  if (parsed === null && text.trim() !== "null") {
    throw new Error(`Expected JSON response from ${options.path}`);
  }

  return parsed as T;
}

export type HttpClient = {
  request: (options: RequestOptions) => Promise<Response>;
  requestJson: <T>(options: JsonRequestOptions) => Promise<T>;
};

export const createClient = (config: ClientConfig): HttpClient => ({
  request: (options) => requestResponse(config, options),
  requestJson: (options) => requestJson(config, options),
});
