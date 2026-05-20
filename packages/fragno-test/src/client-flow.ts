import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

import type {
  AnyFragnoInstantiatedFragment,
  FragnoRequestLifecycleContext,
} from "@fragno-dev/core";

export interface FragmentTestFetcherOptions {
  /**
   * Absolute URL used to resolve relative requests in Node-based tests.
   * This only exists for the Fetch API; requests are still handled in-process.
   */
  baseUrl?: string;
  /** Optional request lifecycle hooks passed to the fragment handler. */
  lifecycleContext?: FragnoRequestLifecycleContext;
}

export interface FragmentTestClientConfigOptions extends FragmentTestFetcherOptions {
  /** Override the mount route used by the client. Defaults to the fragment's mount route. */
  mountRoute?: string;
}

const DEFAULT_TEST_BASE_URL = "http://fragno.test";

export type SubscribableStore<T> = {
  subscribe: (callback: (value: T) => void) => () => void;
};

/** Wait until a nanostore-like store emits a value matching the predicate. */
export function waitForStore<T>(
  store: SubscribableStore<T>,
  predicate: (value: T) => boolean,
): Promise<T> {
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | undefined;
    let shouldUnsubscribe = false;

    unsubscribe = store.subscribe((value) => {
      if (!predicate(value)) {
        return;
      }

      resolve(value);
      if (unsubscribe) {
        unsubscribe();
      } else {
        shouldUnsubscribe = true;
      }
    });

    if (shouldUnsubscribe) {
      unsubscribe();
    }
  });
}

function toRequest(input: RequestInfo | URL, init: RequestInit | undefined, baseUrl: string) {
  if (input instanceof Request) {
    return init ? new Request(input, init) : input;
  }

  const url = input instanceof URL ? input : new URL(String(input), baseUrl);
  return new Request(url, init);
}

/**
 * Create a Fetch-compatible transport that sends requests directly to a Fragno fragment handler.
 *
 * This keeps client tests in-process: client stores/mutators still use the normal Fetch path, while
 * the backend route handler, middleware, request parsing, transactions, and database adapter all run
 * for real.
 */
export function createFragmentTestFetcher(
  fragment: AnyFragnoInstantiatedFragment,
  options: FragmentTestFetcherOptions = {},
): typeof fetch {
  const baseUrl = options.baseUrl ?? DEFAULT_TEST_BASE_URL;

  return async (input, init) => {
    const request = toRequest(input, init, baseUrl);
    return fragment.handler(request, options.lifecycleContext);
  };
}

/**
 * Build a public client config that routes Fragno client hooks/mutators to a fragment in-process.
 */
export function createFragmentTestClientConfig(
  fragment: AnyFragnoInstantiatedFragment,
  options: FragmentTestClientConfigOptions = {},
): FragnoPublicClientConfig {
  const baseUrl = options.baseUrl ?? DEFAULT_TEST_BASE_URL;

  return {
    baseUrl,
    mountRoute: options.mountRoute ?? fragment.mountRoute,
    fetcherConfig: {
      type: "function",
      fetcher: createFragmentTestFetcher(fragment, {
        baseUrl,
        lifecycleContext: options.lifecycleContext,
      }),
      useOnServer: true,
    },
  };
}
