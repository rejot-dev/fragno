import { useCallback, useMemo, useRef, useSyncExternalStore, type DependencyList } from "react";
import type { FetcherValue } from "@nanostores/query";
import type { ClientHookParams, FragnoClientMutatorData, NewFragnoClientHookData } from "./client";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { listenKeys, type ReadableAtom, type Store, type StoreValue } from "nanostores";
import type { NonGetHTTPMethod } from "../api/api";

export type FragnoReactHook<T extends NewFragnoClientHookData<"GET", string, StandardSchemaV1>> = (
  params?: ClientHookParams<T["route"]["path"], string | ReadableAtom<string>>,
) => FetcherValue<StandardSchemaV1.InferOutput<NonNullable<T["route"]["outputSchema"]>>>;

export type FragnoReactMutator<
  T extends FragnoClientMutatorData<NonGetHTTPMethod, string, StandardSchemaV1, StandardSchemaV1>,
> = (
  body: StandardSchemaV1.InferInput<NonNullable<T["route"]["inputSchema"]>>,
  params?: ClientHookParams<T["route"]["path"], string | ReadableAtom<string>>,
) => Promise<StandardSchemaV1.InferOutput<NonNullable<T["route"]["outputSchema"]>>>;

// Type guard to check if a hook is a GET hook
function isGetHook(
  hook:
    | NewFragnoClientHookData<"GET", string, StandardSchemaV1>
    | FragnoClientMutatorData<NonGetHTTPMethod, string, StandardSchemaV1, StandardSchemaV1>,
): hook is NewFragnoClientHookData<"GET", string, StandardSchemaV1> {
  return hook.route.method === "GET" && "store" in hook && "query" in hook;
}

// Type guard to check if a hook is a mutator
function isMutatorHook(
  hook:
    | NewFragnoClientHookData<"GET", string, StandardSchemaV1>
    | FragnoClientMutatorData<NonGetHTTPMethod, string, StandardSchemaV1, StandardSchemaV1>,
): hook is FragnoClientMutatorData<NonGetHTTPMethod, string, StandardSchemaV1, StandardSchemaV1> {
  return (
    hook.route.method !== "GET" && "mutate" in hook && !("store" in hook) && !("query" in hook)
  );
}

// Helper function to create a React hook from a GET hook
function createReactHook<T extends NewFragnoClientHookData<"GET", string, StandardSchemaV1>>(
  hook: T,
): FragnoReactHook<T> {
  return (params?: ClientHookParams<T["route"]["path"], string | ReadableAtom<string>>) => {
    const paramsObj: {
      pathParams?: Record<string, string | ReadableAtom<string>>;
      queryParams?: Record<string, string | ReadableAtom<string>>;
    } = params ?? {};

    const pathParamValues =
      "pathParams" in paramsObj ? Object.values(paramsObj.pathParams ?? {}) : [];
    const queryParamValues = Object.values(paramsObj.queryParams ?? {});

    const deps = [...pathParamValues, ...queryParamValues];

    const store = useMemo(() => hook.store(paramsObj), [hook, ...deps]);

    if (typeof window === "undefined") {
      // TODO(Wilco): Handle server-side rendering. In React we have to implement onShellReady
      // and onAllReady in renderToPipable stream.
      const serverSideData = store.get();
      return serverSideData;
    }

    return useStore(store);
  };
}

// Helper function to create a React mutator from a mutator hook
function createReactMutator<
  T extends FragnoClientMutatorData<NonGetHTTPMethod, string, StandardSchemaV1, StandardSchemaV1>,
>(hook: T): FragnoReactMutator<T> {
  return async (
    body: StandardSchemaV1.InferInput<NonNullable<T["route"]["inputSchema"]>>,
    params?: ClientHookParams<T["route"]["path"], string | ReadableAtom<string>>,
  ) => {
    const paramsObj = params ?? {};
    return hook.mutate(body, paramsObj as ClientHookParams<string, string>);
  };
}

/**
 * Given a record of Fragno client hooks, returns a record mapping each key to the route path string.
 *
 * @param clientObj - A record of Fragno client hooks
 * @returns A record with the same keys, where each value is the route's path string
 */
// Helper type to transform a single hook/mutator
type TransformHook<T> =
  T extends NewFragnoClientHookData<"GET", string, infer O>
    ? FragnoReactHook<NewFragnoClientHookData<"GET", string, O>>
    : T extends FragnoClientMutatorData<infer M, string, infer I, infer O>
      ? FragnoReactMutator<FragnoClientMutatorData<M, string, I, O>>
      : never;

export function useFragno<
  T extends Record<
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | NewFragnoClientHookData<"GET", string, StandardSchemaV1<any, any>>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | FragnoClientMutatorData<NonGetHTTPMethod, string, any, any>
  >,
>(
  clientObj: T,
): {
  [K in keyof T]: TransformHook<T[K]>;
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = {} as any; // We need one any cast here due to TypeScript's limitations with mapped types

  for (const key in clientObj) {
    if (!Object.prototype.hasOwnProperty.call(clientObj, key)) {
      continue;
    }

    const hook = clientObj[key];
    if (isGetHook(hook)) {
      result[key] = createReactHook(hook);
    } else if (isMutatorHook(hook)) {
      result[key] = createReactMutator(hook);
    } else {
      throw new Error(`Hook ${key} doesn't match either GET or mutator type guard`);
    }
  }

  return result;
}

type StoreKeys<T> = T extends { setKey: (k: infer K, v: unknown) => unknown } ? K : never;

export interface UseStoreOptions<SomeStore> {
  /**
   * @default
   * ```ts
   * [store, options.keys]
   * ```
   */
  deps?: DependencyList;

  /**
   * Will re-render components only on specific key changes.
   */
  keys?: StoreKeys<SomeStore>[];
}

export function useStore<SomeStore extends Store>(
  store: SomeStore,
  options: UseStoreOptions<SomeStore> = {},
): StoreValue<SomeStore> {
  const snapshotRef = useRef<StoreValue<SomeStore>>(store.get());

  const { keys, deps = [store, keys] } = options;

  const subscribe = useCallback((onChange: () => void) => {
    // console.log("subscribe#onChange", { keys, deps });
    const emitChange = (value: StoreValue<SomeStore>) => {
      if (snapshotRef.current === value) return;
      snapshotRef.current = value;
      onChange();
    };

    emitChange(store.value);
    if (keys?.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return listenKeys(store as any, keys, emitChange);
    }
    return store.listen(emitChange);
  }, deps);

  const get = () => snapshotRef.current as StoreValue<SomeStore>;

  return useSyncExternalStore(subscribe, get, () => {
    // Server-side rendering
    return get();
  });
}
