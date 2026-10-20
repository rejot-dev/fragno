import { createReson8Fragment } from "@fragno-dev/reson8-fragment";

/**
 * Reson8 under the platform's API key. Callers authorize before reaching it and call routes
 * in-process: the fragment prefers an incoming Authorization header over the key, so forwarding a
 * browser request would send the caller's credentials to Reson8.
 */
export function createReson8Server(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): ReturnType<typeof createReson8Fragment> {
  return createReson8Fragment({ apiKey, fetch: fetchImpl }, { mountRoute: "/api/reson8" });
}

export type Reson8Fragment = ReturnType<typeof createReson8Server>;
