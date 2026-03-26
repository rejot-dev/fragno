import { listenKeys, type ReadableAtom, type Store, type StoreValue } from "nanostores";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type DependencyList,
} from "react";

import type { FetcherValue } from "@nanostores/query";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { NonGetHTTPMethod } from "../api/api";
import type {
  ExtractPathParamsOrWiden,
  HasPathParams,
  MaybeExtractPathParamsOrWiden,
  QueryParamsHint,
} from "../api/internal/path";
import { isReadableAtom } from "../util/nanostores";
import { hydrateFromWindow } from "../util/ssr";
import type { InferOr } from "../util/types-util";
import type { FragnoClientMutatorData, FragnoClientHookData } from "./client";
import {
  isGetHook,
  isMutatorHook,
  isStore,
  type FragnoStoreData,
  type FragnoStoreFactoryData,
  type FragnoStoreObjectData,
} from "./client";
import type { FragnoClientError } from "./client-error";

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

/**
 * Type helper that unwraps any Store fields of the object into StoreValues
 */
type FragnoReactStoreValue<T extends object> =
  T extends Store<infer TStore>
    ? StoreValue<TStore>
    : {
        [K in keyof T]: T[K] extends Store ? StoreValue<T[K]> : T[K];
      };

export type FragnoReactStore<T extends object, TArgs extends unknown[] = []> = (
  ...args: TArgs
) => FragnoReactStoreValue<T>;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const areStoreFactoryValuesEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) {
    return true;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => areStoreFactoryValuesEqual(value, right[index]))
    );
  }

  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }

  if (isReadableAtom(left) || isReadableAtom(right)) {
    return left === right;
  }

  if (typeof left === "function" || typeof right === "function") {
    return left === right;
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] && areStoreFactoryValuesEqual(left[key], right[key]),
      )
    );
  }

  return false;
};

const areStoreFactoryArgsEqual = (left: unknown[], right: unknown[]) =>
  left.length === right.length &&
  left.every((value, index) => areStoreFactoryValuesEqual(value, right[index]));

const getStoreDisposer = (value: object): (() => void) | undefined => {
  const disposer = (value as { [Symbol.dispose]?: (() => void) | undefined })[Symbol.dispose];
  return typeof disposer === "function" ? disposer.bind(value) : undefined;
};

const createReactStoreObjectView = <T extends object>(
  value: T,
  getAtomValue: (store: Store<unknown>) => unknown,
): FragnoReactStoreValue<T> => {
  const atomValues = new Map<Store<unknown>, unknown>();
  const boundMethods = new Map<PropertyKey, unknown>();

  return new Proxy(value, {
    get(target, property, _receiver) {
      const propertyValue = Reflect.get(target, property, target);

      if (isReadableAtom(propertyValue)) {
        if (atomValues.has(propertyValue)) {
          return atomValues.get(propertyValue);
        }

        const atomValue = getAtomValue(propertyValue);
        atomValues.set(propertyValue, atomValue);
        return atomValue;
      }

      if (typeof propertyValue === "function") {
        if (boundMethods.has(property)) {
          return boundMethods.get(property);
        }

        const boundMethod = propertyValue.bind(target);
        boundMethods.set(property, boundMethod);
        return boundMethod;
      }

      return propertyValue;
    },
  }) as FragnoReactStoreValue<T>;
};

function unwrapReactStoreValueOnServer<T extends object>(value: T): FragnoReactStoreValue<T> {
  if (isReadableAtom(value)) {
    return value.get() as FragnoReactStoreValue<T>;
  }

  return createReactStoreObjectView(value, (store) => store.get());
}

function unwrapReactStoreValue<T extends object>(value: T): FragnoReactStoreValue<T> {
  if (isReadableAtom(value)) {
    return useStore(value as Store) as FragnoReactStoreValue<T>;
  }

  const keys = Object.keys(value);
  const atomEntries = keys.flatMap((key) => {
    const fieldValue = value[key as keyof T];
    return isReadableAtom(fieldValue)
      ? ([[key, fieldValue]] as Array<[string, Store<unknown>]>)
      : [];
  });
  const snapshotRef = useRef<unknown[]>(atomEntries.map(([, store]) => store.get()));

  const getSnapshot = () => {
    const nextSnapshot = atomEntries.map(([, store]) => store.get());
    const previousSnapshot = snapshotRef.current;
    if (
      previousSnapshot.length === nextSnapshot.length &&
      previousSnapshot.every((entry, index) => Object.is(entry, nextSnapshot[index]))
    ) {
      return previousSnapshot;
    }
    snapshotRef.current = nextSnapshot;
    return nextSnapshot;
  };

  const atomValues = useSyncExternalStore(
    (onStoreChange) => {
      const unsubscribes = atomEntries.map(([, store]) => store.listen(onStoreChange));
      return () => {
        for (const unsubscribe of unsubscribes) {
          unsubscribe();
        }
      };
    },
    getSnapshot,
    getSnapshot,
  );

  return useMemo(
    () =>
      createReactStoreObjectView(value, (store) => {
        const atomIndex = atomEntries.findIndex(([, entryStore]) => entryStore === store);
        return atomIndex === -1 ? store.get() : atomValues[atomIndex];
      }),
    [value, atomEntries, atomValues],
  );
}

function createReactStore<const T extends object, const TArgs extends unknown[]>(
  hook: FragnoStoreData<T, TArgs>,
): FragnoReactStore<T, TArgs> {
  return ((...args: TArgs) => {
    const stableArgsRef = useRef<TArgs>(args);
    const pendingDisposalsRef = useRef<Map<object, ReturnType<typeof setTimeout>>>(new Map());
    if (!areStoreFactoryArgsEqual(stableArgsRef.current, args)) {
      stableArgsRef.current = args;
    }

    const value = useMemo(() => {
      if ("factory" in hook) {
        return hook.factory(...stableArgsRef.current);
      }

      return hook.obj;
    }, [hook, stableArgsRef.current]);

    useEffect(() => {
      const disposer = getStoreDisposer(value);
      const pendingTimeout = pendingDisposalsRef.current.get(value);
      if (pendingTimeout !== undefined) {
        clearTimeout(pendingTimeout);
        pendingDisposalsRef.current.delete(value);
      }

      return () => {
        if (!disposer) {
          return;
        }

        const timeoutId = setTimeout(() => {
          pendingDisposalsRef.current.delete(value);
          disposer();
        }, 0);
        pendingDisposalsRef.current.set(value, timeoutId);
      };
    }, [value]);

    if (typeof window === "undefined") {
      return unwrapReactStoreValueOnServer(value);
    }

    return unwrapReactStoreValue(value);
  }) as FragnoReactStore<T, TArgs>;
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
      : T[K] extends FragnoStoreObjectData<infer TStoreObj>
        ? FragnoReactStore<TStoreObj, []>
        : T[K] extends FragnoStoreFactoryData<infer TStoreObj, infer TStoreArgs>
          ? FragnoReactStore<TStoreObj, TStoreArgs>
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
    } else if (isStore(hook)) {
      result[key] = createReactStore(hook);
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
      if (snapshotRef.current === value) {
        return;
      }
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
