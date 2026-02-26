export type HttpClientOptions = {
  baseUrl: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
  fetch?: typeof fetch;
};

export type HttpRequestOptions = {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type HttpClient = {
  request: (options: HttpRequestOptions) => Promise<Response>;
};

const joinUrl = (baseUrl: string, path: string): string => {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

const createAbortController = (
  timeoutMs: number,
  externalSignal?: AbortSignal,
): { controller: AbortController; clear: () => void; wasAbortedExternally: () => boolean } => {
  const controller = new AbortController();
  let abortedExternally = false;

  const onExternalAbort = () => {
    abortedExternally = true;
    controller.abort();
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      abortedExternally = true;
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  const timeoutId = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  }, timeoutMs);

  const clear = () => {
    clearTimeout(timeoutId);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  };

  return {
    controller,
    clear,
    wasAbortedExternally: () => abortedExternally,
  };
};

const buildBody = (body: unknown): { body: BodyInit; headers: Record<string, string> } => {
  if (typeof body === "string") {
    return { body, headers: {} };
  }
  return {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  };
};

export const createHttpClient = (options: HttpClientOptions): HttpClient => {
  const fetchImpl = options.fetch ?? fetch;

  const request: HttpClient["request"] = async (requestOptions) => {
    const url = joinUrl(options.baseUrl, requestOptions.path);
    const timeoutMs = requestOptions.timeoutMs ?? options.timeoutMs;
    const maxAttempts = options.retries + 1;

    let attempt = 0;
    let lastError: unknown;

    while (attempt < maxAttempts) {
      attempt += 1;
      const { controller, clear, wasAbortedExternally } = createAbortController(
        timeoutMs,
        requestOptions.signal,
      );

      try {
        const requestHeaders: Record<string, string> = {
          ...options.headers,
          ...requestOptions.headers,
        };

        let body: BodyInit | undefined;
        if (requestOptions.body !== undefined) {
          const bodyResult = buildBody(requestOptions.body);
          body = bodyResult.body;
          const headerKeys = new Set(
            Object.keys(requestHeaders).map((header) => header.toLowerCase()),
          );
          for (const [key, value] of Object.entries(bodyResult.headers)) {
            if (!headerKeys.has(key.toLowerCase())) {
              requestHeaders[key] = value;
            }
          }
        }

        const response = await fetchImpl(url, {
          method: requestOptions.method,
          headers: requestHeaders,
          body,
          signal: controller.signal,
        });

        if (isRetryableStatus(response.status) && attempt < maxAttempts) {
          await delay(options.retryDelayMs);
          continue;
        }

        return response;
      } catch (error) {
        lastError = error;
        const isAbortError = error instanceof Error && error.name === "AbortError";
        const retryable = !wasAbortedExternally() && (isAbortError || error instanceof Error);

        if (!retryable || attempt >= maxAttempts) {
          if (isAbortError && !wasAbortedExternally()) {
            throw new Error(`Request timed out after ${timeoutMs}ms`);
          }
          throw error;
        }

        await delay(options.retryDelayMs);
      } finally {
        clear();
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error("Request failed");
  };

  return { request };
};
