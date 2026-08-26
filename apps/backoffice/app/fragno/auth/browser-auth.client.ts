import {
  BACKOFFICE_AUTH_ERROR_HEADER,
  BACKOFFICE_TOKEN_EXPIRED_CODE,
  type IssueBackofficeTokenResult,
} from "./contracts";
import {
  readPreferredOrganization,
  writePreferredOrganization,
} from "./preferred-organization.client";
import { exchangeBackofficeSessionForJwt } from "./session-exchange.client";

const TOKEN_REFRESH_LEEWAY_MS = 60_000;

type TokenIssuedListener = (result: IssueBackofficeTokenResult) => void;
const tokenIssuedListeners = new Set<TokenIssuedListener>();
let activeRefresh: Promise<IssueBackofficeTokenResult> | null = null;
let knownAccessTokenExpiresAtEpochMs: number | null = null;

export function recordIssuedBackofficeToken(result: IssueBackofficeTokenResult): void {
  knownAccessTokenExpiresAtEpochMs = Date.parse(result.expiresAt);
  for (const listener of tokenIssuedListeners) {
    listener(result);
  }
}

async function issueRefreshedBackofficeAccessToken(
  fetchImplementation: typeof fetch,
): Promise<IssueBackofficeTokenResult> {
  const result = await exchangeBackofficeSessionForJwt(
    { selection: "preferred", organizationId: readPreferredOrganization() },
    fetchImplementation,
  );
  writePreferredOrganization(result.organization?.id ?? null);
  recordIssuedBackofficeToken(result);
  return result;
}

export function refreshBackofficeAccessToken(
  fetchImplementation: typeof fetch = fetch,
): Promise<IssueBackofficeTokenResult> {
  if (!activeRefresh) {
    activeRefresh = issueRefreshedBackofficeAccessToken(fetchImplementation).finally(() => {
      activeRefresh = null;
    });
  }
  return activeRefresh;
}

function normalizeBackofficeAuthRejection(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error("Backoffice authentication rejected with a non-Error reason.", { cause: reason });
}

async function waitForBackofficeAccessTokenRefresh(
  fetchImplementation: typeof fetch,
  requestSignal: AbortSignal | null,
): Promise<void> {
  requestSignal?.throwIfAborted();
  const refresh = refreshBackofficeAccessToken(fetchImplementation);
  if (!requestSignal) {
    await refresh;
    return;
  }

  const activeRequestSignal = requestSignal;
  await new Promise<void>((resolve, reject) => {
    function stopWaitingForAbortedRequest(): void {
      activeRequestSignal.removeEventListener("abort", stopWaitingForAbortedRequest);
      try {
        activeRequestSignal.throwIfAborted();
      } catch (error) {
        reject(normalizeBackofficeAuthRejection(error));
      }
    }

    activeRequestSignal.addEventListener("abort", stopWaitingForAbortedRequest, { once: true });
    void refresh.then(
      () => {
        activeRequestSignal.removeEventListener("abort", stopWaitingForAbortedRequest);
        resolve();
      },
      (error: unknown) => {
        activeRequestSignal.removeEventListener("abort", stopWaitingForAbortedRequest);
        reject(normalizeBackofficeAuthRejection(error));
      },
    );
  });
}

function resolveBackofficeRequestAbortSignal(
  input: RequestInfo | URL,
  init?: RequestInit,
): AbortSignal | null {
  if (init && "signal" in init) {
    return init.signal ?? null;
  }
  return input instanceof Request ? input.signal : null;
}

function isExpiredBackofficeTokenResponse(response: Response): boolean {
  return (
    response.status === 401 &&
    response.headers.get(BACKOFFICE_AUTH_ERROR_HEADER) === BACKOFFICE_TOKEN_EXPIRED_CODE
  );
}

function isReplayableRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return true;
  }
  if (input instanceof Request && input.body !== null) {
    return false;
  }
  return !(init?.body instanceof ReadableStream);
}

export async function backofficeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  fetchImplementation: typeof fetch = fetch,
): Promise<Response> {
  const requestSignal = resolveBackofficeRequestAbortSignal(input, init);
  if (
    knownAccessTokenExpiresAtEpochMs !== null &&
    knownAccessTokenExpiresAtEpochMs - Date.now() <= TOKEN_REFRESH_LEEWAY_MS
  ) {
    await waitForBackofficeAccessTokenRefresh(fetchImplementation, requestSignal);
  }

  const response = await fetchImplementation(input, init);
  if (!isExpiredBackofficeTokenResponse(response) || !isReplayableRequest(input, init)) {
    return response;
  }

  await waitForBackofficeAccessTokenRefresh(fetchImplementation, requestSignal);
  return await fetchImplementation(input, init);
}

export function backofficeTokenRefreshDelay(expiresAt: string, nowEpochMs = Date.now()): number {
  return Math.max(0, Date.parse(expiresAt) - nowEpochMs - TOKEN_REFRESH_LEEWAY_MS);
}

type ScheduleTimeout = (
  callback: () => void,
  delayMilliseconds: number,
) => ReturnType<typeof setTimeout>;
type CancelTimeout = (timeout: ReturnType<typeof setTimeout>) => void;

export const scheduleBackofficeTokenRefresh = (
  initialExpiresAt: string,
  onRefreshFailure: () => void,
  setTimeoutImplementation: ScheduleTimeout = setTimeout,
  clearTimeoutImplementation: CancelTimeout = clearTimeout,
): (() => void) => {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  function schedule(expiresAt: string): void {
    if (timeout !== null) {
      clearTimeoutImplementation(timeout);
    }
    timeout = setTimeoutImplementation(() => {
      timeout = null;
      void refreshBackofficeAccessToken().catch(onRefreshFailure);
    }, backofficeTokenRefreshDelay(expiresAt));
  }

  const listener: TokenIssuedListener = (result) => {
    schedule(result.expiresAt);
  };
  tokenIssuedListeners.add(listener);
  knownAccessTokenExpiresAtEpochMs = Date.parse(initialExpiresAt);
  schedule(initialExpiresAt);

  return () => {
    tokenIssuedListeners.delete(listener);
    if (timeout !== null) {
      clearTimeoutImplementation(timeout);
    }
  };
};
