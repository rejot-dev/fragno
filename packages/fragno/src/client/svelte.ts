import type { StandardSchemaV1 } from "@standard-schema/spec";
import { atom, type ReadableAtom } from "nanostores";
import type { NonGetHTTPMethod } from "../api/api";
import {
  isGetHook,
  isMutatorHook,
  type FragnoClientHookData,
  type FragnoClientMutatorData,
} from "./client";
import type { FragnoClientError } from "./client-error";
import type { InferOr } from "../util/types-util";
import type { MaybeExtractPathParamsOrWiden, QueryParamsHint } from "../api/internal/path";

import { writable, type Readable, get } from "svelte/store";
import { onDestroy } from "svelte";

export type FragnoSvelteHook<
  _TMethod extends "GET",
  TPath extends string,
  TOutputSchema extends StandardSchemaV1,
  TErrorCode extends string,
  TQueryParameters extends string,
> = (args?: {
  path?: MaybeExtractPathParamsOrWiden<TPath, string | Readable<string> | ReadableAtom<string>>;
  query?: QueryParamsHint<TQueryParameters, string | Readable<string> | ReadableAtom<string>>;
}) => {
  data: Readable<InferOr<TOutputSchema, undefined>>;
  loading: Readable<boolean>;
  error: Readable<FragnoClientError<TErrorCode[number]> | undefined>;
};

export type FragnoSvelteMutator<
  _TMethod extends NonGetHTTPMethod,
  TPath extends string,
  TInputSchema extends StandardSchemaV1 | undefined,
  TOutputSchema extends StandardSchemaV1 | undefined,
  TErrorCode extends string,
  TQueryParameters extends string,
> = () => {
  mutate: (args: {
    body?: InferOr<TInputSchema, undefined>;
    path?: MaybeExtractPathParamsOrWiden<TPath, string | Readable<string> | ReadableAtom<string>>;
    query?: QueryParamsHint<TQueryParameters, string | Readable<string> | ReadableAtom<string>>;
  }) => Promise<InferOr<TOutputSchema, undefined>>;
  loading: Readable<boolean | undefined>;
  error: Readable<FragnoClientError<TErrorCode[number]> | undefined>;
  data: Readable<InferOr<TOutputSchema, undefined>>;
};

function isReadable(value: unknown): value is Readable<string> {
  return typeof value === "object" && value !== null && "subscribe" in value;
}

export function readableToAtom<T>(value: Readable<T>): ReadableAtom<T> {
  const a = atom(get(value));

  value.subscribe((newVal) => {
    a.set(newVal);
  });

  return a;
}

function createSvelteHook<
  TMethod extends "GET",
  TPath extends string,
  TOutputSchema extends StandardSchemaV1,
  TErrorCode extends string,
  TQueryParameters extends string,
>(
  hook: FragnoClientHookData<TMethod, TPath, TOutputSchema, TErrorCode, TQueryParameters>,
): FragnoSvelteHook<TMethod, TPath, TOutputSchema, TErrorCode, TQueryParameters> {
  return ({ path, query } = {}) => {
    const pathParams: Record<string, string | ReadableAtom<string>> = {};
    const queryParams: Record<string, string | ReadableAtom<string>> = {};

    for (const [key, value] of Object.entries(path ?? {})) {
      const v = value as string | Readable<string> | ReadableAtom<string>;
      pathParams[key] = isReadable(v) ? readableToAtom(v) : v;
    }

    for (const [key, value] of Object.entries(query ?? {})) {
      const v = value as string | Readable<string> | ReadableAtom<string>;
      queryParams[key] = isReadable(v) ? readableToAtom(v) : v;
    }

    const store = hook.store({
      path: pathParams as MaybeExtractPathParamsOrWiden<TPath, string | ReadableAtom<string>>,
      query: queryParams,
    });

    const data = writable<InferOr<TOutputSchema, undefined>>(undefined);
    const loading = writable<boolean>(false);
    const error = writable<FragnoClientError<TErrorCode[number]> | undefined>(undefined);

    const unsubscribe = store.subscribe((updatedStoreValue) => {
      data.set(updatedStoreValue.data as InferOr<TOutputSchema, undefined>);
      loading.set(updatedStoreValue.loading);
      error.set(updatedStoreValue.error);
    });

    // onDestroy will fail outside of a component context, so to pass tests we try/catch this call
    try {
      onDestroy(() => {
        unsubscribe();
      });
    } catch (error) {
      console.error("Failed to unsubscribe from store", error);
    }

    return {
      data,
      loading,
      error,
    };
  };
}

function createSvelteMutator<
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
): FragnoSvelteMutator<TMethod, TPath, TInputSchema, TOutputSchema, TErrorCode, TQueryParameters> {
  return () => {
    const data = writable<InferOr<TOutputSchema, undefined>>(undefined);
    const loading = writable<boolean | undefined>(undefined);
    const error = writable<FragnoClientError<TErrorCode[number]> | undefined>(undefined);

    // Subscribe to the mutator store and sync with our Svelte stores
    const unsubscribe = hook.mutatorStore.subscribe((storeValue) => {
      data.set(storeValue.data as InferOr<TOutputSchema, undefined>);
      loading.set(storeValue.loading);
      error.set(storeValue.error);
    });

    // onDestroy will fail outside of a component context, so to pass tests we try/catch this call
    try {
      onDestroy(() => {
        unsubscribe();
      });
    } catch (error) {
      console.error("Failed to unsubscribe from store", error);
    }

    // Create a wrapped mutate function that handles Svelte readable stores
    const mutate = async (args: {
      body?: InferOr<TInputSchema, undefined>;
      path?: MaybeExtractPathParamsOrWiden<TPath, string | Readable<string> | ReadableAtom<string>>;
      query?: QueryParamsHint<TQueryParameters, string | Readable<string> | ReadableAtom<string>>;
    }) => {
      const { body, path, query } = args;

      const pathParams: Record<string, string | ReadableAtom<string>> = {};
      const queryParams: Record<string, string | ReadableAtom<string>> = {};

      for (const [key, value] of Object.entries(path ?? {})) {
        const v = value as string | Readable<string> | ReadableAtom<string>;
        pathParams[key] = isReadable(v) ? readableToAtom(v) : v;
      }

      for (const [key, value] of Object.entries(query ?? {})) {
        const v = value as string | Readable<string> | ReadableAtom<string>;
        queryParams[key] = isReadable(v) ? readableToAtom(v) : v;
      }

      // Call the store's mutate function with normalized params
      return hook.mutatorStore.get().mutate({
        body,
        path: pathParams as MaybeExtractPathParamsOrWiden<TPath, string | ReadableAtom<string>>,
        query: queryParams,
      });
    };

    return {
      mutate,
      loading,
      error,
      data,
    };
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
    ? FragnoSvelteHook<"GET", TPath, TOutputSchema, TErrorCode, TQueryParameters>
    : T[K] extends FragnoClientMutatorData<
          infer M,
          infer TPath,
          infer TInputSchema,
          infer TOutputSchema,
          infer TErrorCode,
          infer TQueryParameters
        >
      ? FragnoSvelteMutator<M, TPath, TInputSchema, TOutputSchema, TErrorCode, TQueryParameters>
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
      result[key] = createSvelteHook(hook);
    } else if (isMutatorHook(hook)) {
      result[key] = createSvelteMutator(hook);
    } else {
      // Pass through non-hook values unchanged
      result[key] = hook;
    }
  }

  return result;
}
