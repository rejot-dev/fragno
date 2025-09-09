import type { FetcherValue } from "@nanostores/query";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { listenKeys, type ReadableAtom, type Store, type StoreValue } from "nanostores";
import { useCallback, useMemo, useRef, useSyncExternalStore, type DependencyList } from "react";
import type { NonGetHTTPMethod } from "../api/api";
import type { FragnoClientMutatorData, FragnoClientHookData } from "./client";
import { isGetHook, isMutatorHook } from "./client";
import type { FragnoClientError } from "./client-error";
import { hydrateFromWindow } from "../util/ssr";
import type { InferOr } from "../util/types-util";
import type {
  ExtractPathParamsOrWiden,
  HasPathParams,
  MaybeExtractPathParamsOrWiden,
  QueryParamsHint,
} from "../api/internal/path";

export type FragnoReactHook<
  _TMethod extends "GET",
  TPath extends string,
  TOutputSchema extends StandardSchemaV1,
  TErrorCode extends string,
  TQueryParameters extends string,
> = (args?: {
  path?: MaybeExtractPathParamsOrWiden<TPath, string | ReadableAtom<string>>;
  query?: QueryParamsHint<TQueryParameters, string | ReadableAtom<string>>;
}) => FetcherValue<
  StandardSchemaV1.InferOutput<TOutputSchema>,
  FragnoClientError<NonNullable<TErrorCode>>
>;

export type FragnoReactMutator<
  _TMethod extends NonGetHTTPMethod,
  TPath extends string,
  TInputSchema extends StandardSchemaV1 | undefined,
  TOutputSchema extends StandardSchemaV1 | undefined,
  TErrorCode extends string,
  TQueryParameters extends string,
> = () => {
  mutate: ({
    body,
    path,
    query,
  }: {
    body?: InferOr<TInputSchema, undefined>;
    path?: HasPathParams<TPath> extends true
      ? ExtractPathParamsOrWiden<TPath, string | ReadableAtom<string>>
      : undefined;
    query?: QueryParamsHint<TQueryParameters, string | ReadableAtom<string>>;
  }) => Promise<InferOr<TOutputSchema, undefined>>;
  loading?: boolean | undefined;
  error?: FragnoClientError<NonNullable<TErrorCode>[number]> | undefined;
  data?: InferOr<TOutputSchema, undefined> | undefined;
};

// Helper function to create a React hook from a GET hook
function createReactHook<
  TMethod extends "GET",
  TPath extends string,
  TOutputSchema extends StandardSchemaV1,
  TErrorCode extends string,
  TQueryParameters extends string,
>(
  hook: FragnoClientHookData<TMethod, TPath, TOutputSchema, TErrorCode, TQueryParameters>,
): FragnoReactHook<TMethod, TPath, TOutputSchema, TErrorCode, TQueryParameters> {
  return ({ path, query } = {}) => {
    const pathParamValues = path ? Object.values(path) : [];
    const queryParamValues = query ? Object.values(query) : [];

    const deps = [...pathParamValues, ...queryParamValues];

    const store = useMemo(() => hook.store({ path, query }), [hook, ...deps]);

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
  TMethod extends NonGetHTTPMethod,
  TPath extends string,
  TInput extends StandardSchemaV1 | undefined,
  TOutput extends StandardSchemaV1 | undefined,
  TError extends string,
  TQueryParameters extends string,
>(
  hook: FragnoClientMutatorData<TMethod, TPath, TInput, TOutput, TError, TQueryParameters>,
): FragnoReactMutator<TMethod, TPath, TInput, TOutput, TError, TQueryParameters> {
  return () => {
    const store = useMemo(() => hook.mutatorStore, [hook]);
    return useStore(store);
  };
}

export function useFragno<T extends Record<string, unknown>>(
  clientObj: T,
): {
  [K in keyof T]: T[K] extends FragnoClientHookData<
    "GET",
    infer TPath,
    infer TOutputSchema,
    infer TErrorCode,
    infer TQueryParameters
  >
    ? FragnoReactHook<"GET", TPath, TOutputSchema, TErrorCode, TQueryParameters>
    : T[K] extends FragnoClientMutatorData<
          infer TMethod,
          infer TPath,
          infer TInput,
          infer TOutput,
          infer TError,
          infer TQueryParameters
        >
      ? FragnoReactMutator<TMethod, TPath, TInput, TOutput, TError, TQueryParameters>
      : T[K];
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
      // Pass through non-hook values unchanged
      result[key] = hook;
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

export function FragnoHydrator({ children }: { children: React.ReactNode }) {
  // Ensure initial data is transferred from window before any hooks run
  // Running in useMemo makes this happen during render, ahead of effects
  useMemo(() => {
    hydrateFromWindow();
  }, []);
  return children;
}
