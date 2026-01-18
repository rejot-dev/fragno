export type ClientConfig = {
  baseUrl: string;
  headers?: HeadersInit;
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
};

export type ListInstancesParams = {
  workflowName: string;
  status?: string;
  pageSize?: number;
  cursor?: string;
};

export type HistoryParams = {
  workflowName: string;
  instanceId: string;
  runNumber?: number;
  pageSize?: number;
  stepsCursor?: string;
  eventsCursor?: string;
  logsCursor?: string;
  includeLogs?: boolean;
  logLevel?: string;
  logCategory?: string;
  order?: string;
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

const safeJsonParse = (text: string) => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

export function createClient(config: ClientConfig) {
  return {
    listWorkflows: () => requestJson<{ workflows: Array<{ name: string }> }>(config, "/workflows"),
    listInstances: (params: ListInstancesParams) =>
      requestJson<{
        instances: Array<{ id: string; details: Record<string, unknown> }>;
        cursor?: string;
        hasNextPage: boolean;
      }>(config, `/workflows/${params.workflowName}/instances`, {
        query: {
          status: params.status,
          pageSize: params.pageSize,
          cursor: params.cursor,
        },
      }),
    getInstance: (params: { workflowName: string; instanceId: string }) =>
      requestJson<{
        id: string;
        details: Record<string, unknown>;
        meta: Record<string, unknown>;
      }>(config, `/workflows/${params.workflowName}/instances/${params.instanceId}`),
    createInstance: (params: { workflowName: string; id?: string; params?: unknown }) =>
      requestJson<{ id: string; details: Record<string, unknown> }>(
        config,
        `/workflows/${params.workflowName}/instances`,
        {
          method: "POST",
          body: {
            id: params.id,
            params: params.params,
          },
        },
      ),
    sendEvent: (params: {
      workflowName: string;
      instanceId: string;
      type: string;
      payload?: unknown;
    }) =>
      requestJson<{ status: Record<string, unknown> }>(
        config,
        `/workflows/${params.workflowName}/instances/${params.instanceId}/events`,
        {
          method: "POST",
          body: {
            type: params.type,
            payload: params.payload,
          },
        },
      ),
    manageInstance: (params: {
      workflowName: string;
      instanceId: string;
      action: "pause" | "resume" | "restart" | "terminate";
    }) =>
      requestJson<{ ok: boolean }>(
        config,
        `/workflows/${params.workflowName}/instances/${params.instanceId}/${params.action}`,
        { method: "POST" },
      ),
    history: (params: HistoryParams) =>
      requestJson<{
        runNumber: number;
        steps: Array<Record<string, unknown>>;
        events: Array<Record<string, unknown>>;
        stepsCursor?: string;
        stepsHasNextPage: boolean;
        eventsCursor?: string;
        eventsHasNextPage: boolean;
        logs?: Array<Record<string, unknown>>;
        logsCursor?: string;
        logsHasNextPage?: boolean;
      }>(config, `/workflows/${params.workflowName}/instances/${params.instanceId}/history`, {
        query: {
          runNumber: params.runNumber,
          pageSize: params.pageSize,
          stepsCursor: params.stepsCursor,
          eventsCursor: params.eventsCursor,
          logsCursor: params.logsCursor,
          includeLogs: params.includeLogs,
          logLevel: params.logLevel,
          logCategory: params.logCategory,
          order: params.order,
        },
      }),
  };
}
