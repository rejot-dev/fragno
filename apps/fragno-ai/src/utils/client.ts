export type ClientConfig = {
  baseUrl: string;
  headers?: HeadersInit;
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
};

type RequestOptions = {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

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

const safeJsonParse = (text: string) => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

async function requestJson<T>(
  config: ClientConfig,
  path: string,
  { method = "GET", query, body }: RequestOptions = {},
): Promise<T> {
  const url = buildUrl(config.baseUrl, path, query);
  const headers = new Headers(config.headers ?? {});
  let payload: string | undefined;

  if (body !== undefined) {
    headers.set("content-type", "application/json");
    payload = JSON.stringify(body);
  }

  const response = await fetchWithRetry(
    url,
    {
      method,
      headers,
      body: payload,
    },
    config,
  );

  const text = await response.text();
  const parsed = text ? safeJsonParse(text) : undefined;

  if (!response.ok) {
    const errorPayload = parsed as { message?: string; code?: string } | undefined;
    const message = errorPayload?.message ?? text ?? response.statusText;
    const code = errorPayload?.code ? ` (${errorPayload.code})` : "";
    throw new Error(`Request failed: ${response.status} ${message}${code}`);
  }

  if (parsed === undefined) {
    return undefined as T;
  }

  if (parsed === null && text.trim() !== "null") {
    throw new Error(`Expected JSON response from ${url}`);
  }

  return parsed as T;
}

async function requestStream(
  config: ClientConfig,
  path: string,
  { method = "POST", query, body }: RequestOptions = {},
): Promise<Response> {
  const url = buildUrl(config.baseUrl, path, query);
  const headers = new Headers(config.headers ?? {});
  let payload: string | undefined;

  if (body !== undefined) {
    headers.set("content-type", "application/json");
    payload = JSON.stringify(body);
  }

  const response = await fetchWithRetry(
    url,
    {
      method,
      headers,
      body: payload,
    },
    config,
  );

  if (response.ok) {
    return response;
  }

  const text = await response.text();
  const parsed = text ? safeJsonParse(text) : undefined;
  const errorPayload = parsed as { message?: string; code?: string } | undefined;
  const message = errorPayload?.message ?? text ?? response.statusText;
  const code = errorPayload?.code ? ` (${errorPayload.code})` : "";
  throw new Error(`Request failed: ${response.status} ${message}${code}`);
}

export function createClient(config: ClientConfig) {
  return {
    listThreads: (params?: { pageSize?: number; cursor?: string; order?: string }) =>
      requestJson<{
        threads: Array<Record<string, unknown>>;
        cursor?: string;
        hasNextPage: boolean;
      }>(config, "/threads", { query: params }),
    getThread: (params: { threadId: string }) =>
      requestJson<Record<string, unknown>>(config, `/threads/${params.threadId}`),
    createThread: (params: {
      title?: string | null;
      systemPrompt?: string | null;
      defaultModelId?: string;
      defaultThinkingLevel?: string;
      openaiToolConfig?: unknown | null;
      metadata?: unknown | null;
    }) =>
      requestJson<Record<string, unknown>>(config, "/threads", { method: "POST", body: params }),
    updateThread: (params: {
      threadId: string;
      title?: string | null;
      systemPrompt?: string | null;
      defaultModelId?: string;
      defaultThinkingLevel?: string;
      openaiToolConfig?: unknown | null;
      metadata?: unknown | null;
    }) =>
      requestJson<Record<string, unknown>>(config, `/threads/${params.threadId}`, {
        method: "PATCH",
        body: {
          title: params.title,
          systemPrompt: params.systemPrompt,
          defaultModelId: params.defaultModelId,
          defaultThinkingLevel: params.defaultThinkingLevel,
          openaiToolConfig: params.openaiToolConfig,
          metadata: params.metadata,
        },
      }),
    deleteThread: (params: { threadId: string }) =>
      requestJson<{ ok: boolean }>(config, `/admin/threads/${params.threadId}`, {
        method: "DELETE",
      }),
    listMessages: (params: {
      threadId: string;
      pageSize?: number;
      cursor?: string;
      order?: string;
    }) =>
      requestJson<{
        messages: Array<Record<string, unknown>>;
        cursor?: string;
        hasNextPage: boolean;
      }>(config, `/threads/${params.threadId}/messages`, {
        query: {
          pageSize: params.pageSize,
          cursor: params.cursor,
          order: params.order,
        },
      }),
    appendMessage: (params: {
      threadId: string;
      role: string;
      content: unknown;
      text?: string | null;
      runId?: string | null;
    }) =>
      requestJson<Record<string, unknown>>(config, `/threads/${params.threadId}/messages`, {
        method: "POST",
        body: {
          role: params.role,
          content: params.content,
          text: params.text,
          runId: params.runId,
        },
      }),
    listRuns: (params: { threadId: string; pageSize?: number; cursor?: string; order?: string }) =>
      requestJson<{
        runs: Array<Record<string, unknown>>;
        cursor?: string;
        hasNextPage: boolean;
      }>(config, `/threads/${params.threadId}/runs`, {
        query: {
          pageSize: params.pageSize,
          cursor: params.cursor,
          order: params.order,
        },
      }),
    getRun: (params: { runId: string }) =>
      requestJson<Record<string, unknown>>(config, `/runs/${params.runId}`),
    createRun: (params: {
      threadId: string;
      type?: string;
      executionMode?: string;
      inputMessageId?: string;
      modelId?: string;
      thinkingLevel?: string;
      systemPrompt?: string | null;
    }) =>
      requestJson<Record<string, unknown>>(config, `/threads/${params.threadId}/runs`, {
        method: "POST",
        body: {
          type: params.type,
          executionMode: params.executionMode,
          inputMessageId: params.inputMessageId,
          modelId: params.modelId,
          thinkingLevel: params.thinkingLevel,
          systemPrompt: params.systemPrompt,
        },
      }),
    streamRun: (params: {
      threadId: string;
      type?: string;
      inputMessageId?: string;
      modelId?: string;
      thinkingLevel?: string;
      systemPrompt?: string | null;
    }) =>
      requestStream(config, `/threads/${params.threadId}/runs:stream`, {
        method: "POST",
        body: {
          type: params.type,
          inputMessageId: params.inputMessageId,
          modelId: params.modelId,
          thinkingLevel: params.thinkingLevel,
          systemPrompt: params.systemPrompt,
        },
      }),
    cancelRun: (params: { runId: string }) =>
      requestJson<Record<string, unknown>>(config, `/runs/${params.runId}/cancel`, {
        method: "POST",
      }),
    listRunEvents: (params: {
      runId: string;
      pageSize?: number;
      cursor?: string;
      order?: string;
    }) =>
      requestJson<{
        events: Array<Record<string, unknown>>;
        cursor?: string;
        hasNextPage: boolean;
      }>(config, `/runs/${params.runId}/events`, {
        query: {
          pageSize: params.pageSize,
          cursor: params.cursor,
          order: params.order,
        },
      }),
    listArtifacts: (params: { runId: string }) =>
      requestJson<{ artifacts: Array<Record<string, unknown>> }>(
        config,
        `/runs/${params.runId}/artifacts`,
      ),
    getArtifact: (params: { artifactId: string }) =>
      requestJson<Record<string, unknown>>(config, `/artifacts/${params.artifactId}`),
  };
}
