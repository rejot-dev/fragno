import type { StandardSchemaV1 } from "@standard-schema/spec";
import { atom, type ReadableAtom, type Store, type StoreValue } from "nanostores";
import type { DeepReadonly, Ref, ShallowRef, UnwrapNestedRefs } from "vue";
import { computed, getCurrentScope, isRef, onScopeDispose, ref, shallowRef, watch } from "vue";
import type { NonGetHTTPMethod } from "../api/api";
import {
  isGetHook,
  isMutatorHook,
  isStore,
  type FragnoClientMutatorData,
  type FragnoClientHookData,
  type FragnoStoreData,
} from "./client";
import type { FragnoClientError } from "./client-error";
import type { MaybeExtractPathParamsOrWiden, QueryParamsHint } from "../api/internal/path";
import { isReadableAtom } from "../util/nanostores";
import type { InferOr } from "../util/types-util";

export type FragnoVueHook<
  _TMethod extends "GET",
  TPath extends string,
  TOutputSchema extends StandardSchemaV1,
  TErrorCode extends string,
  TQueryParameters extends string,
> = (args?: {
  path?: MaybeExtractPathParamsOrWiden<TPath, string | Ref<string> | ReadableAtom<string>>;
  query?: QueryParamsHint<TQueryParameters, string | Ref<string> | ReadableAtom<string>>;
}) => {
  data: Ref<InferOr<TOutputSchema, undefined>>;
  loading: Ref<boolean>;
  error: Ref<FragnoClientError<TErrorCode[number]> | undefined>;
};

export type FragnoVueMutator<
  _TMethod extends NonGetHTTPMethod,
  TPath extends string,
  TInputSchema extends StandardSchemaV1 | undefined,
  TOutputSchema extends StandardSchemaV1 | undefined,
  TErrorCode extends string,
  TQueryParameters extends string,
> = () => {
  mutate: (args: {
    body?: InferOr<TInputSchema, undefined>;
    path?: MaybeExtractPathParamsOrWiden<TPath, string | Ref<string> | ReadableAtom<string>>;
    query?: QueryParamsHint<TQueryParameters, string | Ref<string> | ReadableAtom<string>>;
  }) => Promise<InferOr<TOutputSchema, undefined>>;
  loading: Ref<boolean | undefined>;
  error: Ref<FragnoClientError<TErrorCode[number]> | undefined>;
  data: Ref<InferOr<TOutputSchema, undefined>>;
};

/**
 * Type helper that unwraps any Store fields of the object into StoreValues for Vue
 */
export type FragnoVueStore<T extends object> = () => T extends Store<infer TStore>
  ? DeepReadonly<UnwrapNestedRefs<ShallowRef<StoreValue<TStore>>>>
  : {
      [K in keyof T]: T[K] extends Store
        ? DeepReadonly<UnwrapNestedRefs<ShallowRef<StoreValue<T[K]>>>>
        : T[K];
    };

/**
 * Converts a Vue Ref to a NanoStore Atom.
 *
 * This is used to convert Vue refs to atoms, so that we can use them in the store.
 *
 * @private
 */
export function refToAtom<T>(ref: Ref<T>): ReadableAtom<T> {
  const a = atom(ref.value);

  watch(ref, (newVal) => {
    a.set(newVal);
  });

  // TODO: Do we need to unsubscribe, or is this handled by `onScopeDispose` below?

  return a;
}

// Helper function to create a Vue composable from a GET hook
// We want 1 store per hook, so on updates to params, we need to update the store instead of creating a new one.
// Nanostores only works with atoms (or strings), so we need to convert vue refs to atoms.
function createVueHook<
  TMethod extends "GET",
  TPath extends string,
  TOutputSchema extends StandardSchemaV1,
  TErrorCode extends string,
  TQueryParameters extends string,
>(
  hook: FragnoClientHookData<TMethod, TPath, TOutputSchema, TErrorCode, TQueryParameters>,
): FragnoVueHook<TMethod, TPath, TOutputSchema, TErrorCode, TQueryParameters> {
  return ({ path, query } = {}) => {
    const pathParams: Record<string, string | ReadableAtom<string>> = {};
    const queryParams: Record<string, string | ReadableAtom<string>> = {};

    for (const [key, value] of Object.entries(path ?? {})) {
      const v = value as string | Ref<string> | ReadableAtom<string>;
      pathParams[key] = isRef(v) ? refToAtom(v) : v;
    }

    for (const [key, value] of Object.entries(query ?? {})) {
      // Dunno why the cast is necessary
      const v = value as string | Ref<string> | ReadableAtom<string>;
      queryParams[key] = isRef(v) ? (refToAtom(v) as ReadableAtom<string>) : v;
    }

    const store = hook.store({
      path: pathParams as MaybeExtractPathParamsOrWiden<TPath, string | ReadableAtom<string>>,
      query: queryParams,
    });

    const data = ref();
    const loading = ref();
    const error = ref();

    const unsubscribe = store.subscribe((updatedStoreValue) => {
      data.value = updatedStoreValue.data;
      loading.value = updatedStoreValue.loading;
      error.value = updatedStoreValue.error;
    });

    if (getCurrentScope()) {
      onScopeDispose(() => {
        unsubscribe();
      });
    }

    return {
      data,
      loading,
      error,
    };
  };
}

// Helper function to create a Vue mutator from a mutator hook
function createVueMutator<
  TMethod extends NonGetHTTPMethod,
  TPath extends string,
  TInputSchema extends StandardSchemaV1 | undefined,
  TOutputSchema extends StandardSchemaV1 | undefined,
  TErrorCode extends string,
  TQueryParameters extends string,
>(
  hook: FragnoClientMutatorData<
    TMethod,
    TPath,
    TInputSchema,
    TOutputSchema,
    TErrorCode,
    TQueryParameters
  >,
): FragnoVueMutator<TMethod, TPath, TInputSchema, TOutputSchema, TErrorCode, TQueryParameters> {
  return () => {
    const store = useStore(hook.mutatorStore);

    // Create a wrapped mutate function that handles Vue refs
    const mutate = async (args: {
      body?: InferOr<TInputSchema, undefined>;
      path?: MaybeExtractPathParamsOrWiden<TPath, string | Ref<string> | ReadableAtom<string>>;
      query?: QueryParamsHint<TQueryParameters, string | Ref<string> | ReadableAtom<string>>;
    }) => {
      const { body, path, query } = args;

      const pathParams: Record<string, string | ReadableAtom<string>> = {};
      const queryParams: Record<string, string | ReadableAtom<string>> = {};

      for (const [key, value] of Object.entries(path ?? {})) {
        const v = value as string | Ref<string> | ReadableAtom<string>;
        pathParams[key] = isRef(v) ? v.value : v;
      }

      for (const [key, value] of Object.entries(query ?? {})) {
        const v = value as string | Ref<string> | ReadableAtom<string>;
        queryParams[key] = isRef(v) ? v.value : v;
      }

      // Call the store's mutate function with normalized params
      return store.value.mutate({
        body,
        path: pathParams as MaybeExtractPathParamsOrWiden<TPath, string | ReadableAtom<string>>,
        query: queryParams,
      });
    };

    // Return the store-like object with Vue reactive refs
    return {
      mutate,
      loading: computed(() => store.value.loading),
      error: computed(() => store.value.error),
      data: computed(() => store.value.data) as Ref<InferOr<TOutputSchema, undefined>>,
    };
  };
}

function createVueStore<const T extends object>(hook: FragnoStoreData<T>): FragnoVueStore<T> {
  if (isReadableAtom(hook.obj)) {
    return () => useStore(hook.obj as Store) as T extends Store<infer TStore>
      ? DeepReadonly<UnwrapNestedRefs<ShallowRef<StoreValue<TStore>>>>
      : never;
  }

  return () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = {};

    for (const key in hook.obj) {
      if (!Object.prototype.hasOwnProperty.call(hook.obj, key)) {
        continue;
      }

      const value = hook.obj[key];
      if (isReadableAtom(value)) {
        result[key] = useStore(value);
      } else {
        result[key] = value;
      }
    }

    return result;
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
    ? FragnoVueHook<"GET", TPath, TOutputSchema, TErrorCode, TQueryParameters>
    : T[K] extends FragnoClientMutatorData<
          infer M,
          infer TPath,
          infer TInputSchema,
          infer TOutputSchema,
          infer TErrorCode,
          infer TQueryParameters
        >
      ? FragnoVueMutator<M, TPath, TInputSchema, TOutputSchema, TErrorCode, TQueryParameters>
      : T[K] extends FragnoStoreData<infer TStoreObj>
        ? FragnoVueStore<TStoreObj>
        : T[K];
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = {} as any;

  for (const key in clientObj) {
    if (!Object.prototype.hasOwnProperty.call(clientObj, key)) {
      continue;
    }

    const hook = clientObj[key];
    if (isGetHook(hook)) {
      result[key] = createVueHook(hook);
    } else if (isMutatorHook(hook)) {
      result[key] = createVueMutator(hook);
    } else if (isStore(hook)) {
      result[key] = createVueStore(hook);
    } else {
      // Pass through non-hook values unchanged
      result[key] = hook;
    }
  }

  return result;
}

export function useStore<SomeStore extends Store, Value extends StoreValue<SomeStore>>(
  store: SomeStore,
): DeepReadonly<UnwrapNestedRefs<ShallowRef<Value>>> {
  const state = shallowRef();

  const unsubscribe = store.subscribe((value) => {
    state.value = value;
  });

  if (getCurrentScope()) {
    onScopeDispose(unsubscribe);
  }

  return state;
}
