import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ReadableAtom } from "nanostores";
import type { NonGetHTTPMethod } from "../api/api";
import {
  isGetHook,
  isMutatorHook,
  type FragnoClientMutatorData,
  type NewFragnoClientHookData,
} from "./client";
import type { FragnoClientError } from "./client-error";
import { createAsyncIteratorFromCallback } from "../util/async";
import type { InferOr, AnyStandardSchema } from "../util/types-util";
import type { ExtractPathParamsOrWiden, HasPathParams } from "../api/internal/path";

export type StoreData<
  TOutputSchema extends StandardSchemaV1 | undefined,
  TErrorCodes extends string,
> = {
  loading: boolean;
  error?: FragnoClientError<TErrorCodes>;
  data?: InferOr<TOutputSchema, undefined>;
};

export type FragnoVanillaListeners<
  _TMethod extends "GET",
  TPath extends string,
  TOutputSchema extends StandardSchemaV1,
  TErrorCode extends string,
> = (
  path?: ExtractPathParamsOrWiden<TPath, string | ReadableAtom<string>>,
  query?: Record<string, string | ReadableAtom<string>>,
) => {
  listen: (callback: (value: StoreData<TOutputSchema, TErrorCode[number]>) => void) => () => void;
  subscribe: (
    callback: (value: StoreData<TOutputSchema, TErrorCode[number]>) => void,
  ) => () => void;
  get: () => StoreData<TOutputSchema, TErrorCode[number]>;
  refetch: () => void;
  [Symbol.asyncIterator]: () => AsyncGenerator<
    StoreData<TOutputSchema, TErrorCode[number]>,
    void,
    unknown
  >;
};

function createVanillaListeners<
  _TMethod extends "GET",
  TPath extends string,
  TOutputSchema extends StandardSchemaV1,
  TErrorCode extends string,
>(
  hook: NewFragnoClientHookData<"GET", TPath, TOutputSchema, TErrorCode>,
): FragnoVanillaListeners<_TMethod, TPath, TOutputSchema, TErrorCode> {
  return (path?, query?) => {
    const store = hook.store(path, query);

    return {
      listen: (callback) => {
        return store.listen(({ loading, error, data }) =>
          callback({
            loading,
            error,
            data: data as InferOr<TOutputSchema, undefined>,
          }),
        );
      },
      subscribe: (callback) => {
        return store.subscribe(({ loading, error, data }) =>
          callback({
            loading,
            error,
            data: data as InferOr<TOutputSchema, undefined>,
          }),
        );
      },
      refetch: () => {
        return store.revalidate();
      },
      get: () => {
        return store.get() as StoreData<TOutputSchema, TErrorCode[number]>;
      },
      [Symbol.asyncIterator]() {
        return createAsyncIteratorFromCallback((callback) =>
          store.listen(({ loading, error, data }) =>
            callback({
              loading,
              error,
              data: data as InferOr<TOutputSchema, undefined>,
            }),
          ),
        );
      },
    };
  };
}

export type FragnoVanillaMutator<
  _TMethod extends NonGetHTTPMethod,
  TPath extends string,
  TInputSchema extends StandardSchemaV1 | undefined,
  TOutputSchema extends StandardSchemaV1 | undefined,
  TErrorCode extends string,
> = (
  path?: ExtractPathParamsOrWiden<TPath, string | ReadableAtom<string>>,
  query?: Record<string, string | ReadableAtom<string>>,
) => {
  subscribe: (
    callback: (value: {
      loading: boolean;
      error?: FragnoClientError<TErrorCode[number]>;
      data?: InferOr<TOutputSchema, undefined>;
    }) => void,
  ) => () => void;
  get: () => StoreData<TOutputSchema, TErrorCode[number]>;
  mutate: ({
    body,
    path,
    query,
  }: {
    body?: InferOr<TInputSchema, undefined>;
    path?: HasPathParams<TPath> extends true
      ? ExtractPathParamsOrWiden<TPath, string | ReadableAtom<string>>
      : undefined;
    query?: Record<string, string | ReadableAtom<string>>;
  }) => Promise<InferOr<TOutputSchema, undefined>>;
  [Symbol.asyncIterator]: () => AsyncGenerator<
    StoreData<TOutputSchema, TErrorCode[number]>,
    void,
    unknown
  >;
};

function createVanillaMutator<
  _TMethod extends NonGetHTTPMethod,
  TPath extends string,
  TInputSchema extends StandardSchemaV1 | undefined,
  TOutputSchema extends StandardSchemaV1 | undefined,
  TErrorCode extends string,
>(
  hook: FragnoClientMutatorData<_TMethod, TPath, TInputSchema, TOutputSchema, TErrorCode>,
): FragnoVanillaMutator<_TMethod, TPath, TInputSchema, TOutputSchema, TErrorCode> {
  return () => {
    const store = hook.mutatorStore;
    return {
      subscribe: (callback) => {
        return store.subscribe((value) => {
          callback({
            loading: value.loading ?? false,
            error: value.error,
            data: value.data,
          });
        });
      },
      get: () => {
        const { loading, error, data } = store.get();
        return {
          loading: loading ?? false,
          error,
          data: data,
        };
      },
      mutate: ({ body, path, query }) => {
        return store.mutate({ body, path, query });
      },
      [Symbol.asyncIterator]() {
        return createAsyncIteratorFromCallback((callback) =>
          store.listen((value) => {
            callback({
              loading: value.loading ?? false,
              error: value.error,
              data: value.data,
            });
          }),
        );
      },
    };
  };
}

export function useFragno<
  T extends Record<
    string,
    | NewFragnoClientHookData<"GET", string, AnyStandardSchema, string>
    | FragnoClientMutatorData<
        NonGetHTTPMethod,
        string,
        AnyStandardSchema | undefined,
        AnyStandardSchema | undefined,
        string
      >
  >,
>(
  clientObj: T,
): {
  [K in keyof T]: T[K] extends NewFragnoClientHookData<
    "GET",
    infer TPath,
    infer TOutputSchema,
    infer TErrorCode
  >
    ? FragnoVanillaListeners<"GET", TPath, TOutputSchema, TErrorCode>
    : T[K] extends FragnoClientMutatorData<
          NonGetHTTPMethod,
          infer TPath,
          infer TInputSchema,
          infer TOutputSchema,
          infer TErrorCode
        >
      ? FragnoVanillaMutator<NonGetHTTPMethod, TPath, TInputSchema, TOutputSchema, TErrorCode>
      : never;
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = {} as any; // We need one any cast here due to TypeScript's limitations with mapped types

  for (const key in clientObj) {
    if (!Object.prototype.hasOwnProperty.call(clientObj, key)) {
      continue;
    }

    const hook = clientObj[key];
    if (isGetHook(hook)) {
      result[key] = createVanillaListeners(hook);
    } else if (isMutatorHook(hook)) {
      result[key] = createVanillaMutator(hook);
    } else {
      throw new Error(`Hook ${key} doesn't match either GET or mutator type guard`);
    }
  }

  return result;
}
