import { useCallback, useMemo, useRef, useSyncExternalStore, type DependencyList } from "react";
import type { FetcherValue } from "@nanostores/query";
import type { ClientHookParams, NewFragnoClientHookData } from "./client";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { listenKeys, type ReadableAtom, type Store, type StoreValue } from "nanostores";

export type FragnoReactHook<T extends NewFragnoClientHookData<"GET", string, StandardSchemaV1>> = (
  params?: ClientHookParams<T["route"]["path"], string | ReadableAtom<string>>,
) => FetcherValue<StandardSchemaV1.InferOutput<NonNullable<T["route"]["outputSchema"]>>>;

/**
 * Given a record of Fragno client hooks, returns a record mapping each key to the route path string.
 *
 * @param hooks - A record of Fragno client hooks
 * @returns A record with the same keys, where each value is the route's path string
 */
export function useFragnoHooks<
  T extends Record<
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    NewFragnoClientHookData<"GET", string, StandardSchemaV1<any, any>>
  >,
>(
  hooks: T,
): {
  [K in keyof T]: FragnoReactHook<T[K]>;
} {
  const result = {} as {
    [K in keyof T]: FragnoReactHook<T[K]>;
  };

  // const stores = {} as {
  //   [K in keyof T]: FetcherStore<StandardSchemaV1.InferOutput<NonNullable<T[K]["route"]["outputSchema"]>>>;
  // };

  for (const hookKey in hooks) {
    if (Object.prototype.hasOwnProperty.call(hooks, hookKey)) {
      result[hookKey] = (
        params?: ClientHookParams<
          T[typeof hookKey]["route"]["path"],
          string | ReadableAtom<string>
        >,
      ) => {
        const paramsObj: {
          pathParams?: Record<string, string | ReadableAtom<string>>;
          queryParams?: Record<string, string | ReadableAtom<string>>;
        } = params ?? {};

        const pathParamValues =
          "pathParams" in paramsObj ? Object.values(paramsObj.pathParams ?? {}) : [];
        const queryParamValues = Object.values(paramsObj.queryParams ?? {});

        const deps = [...pathParamValues, ...queryParamValues];

        const store = useMemo(() => hooks[hookKey].store(paramsObj), [hooks[hookKey], ...deps]);
        return useStore(store);
      };
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

  // console.log("useStore.value", store.get());

  return useSyncExternalStore(subscribe, get, get);
}
