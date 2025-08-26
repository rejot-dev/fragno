import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ReadableAtom } from "nanostores";
import type { NonGetHTTPMethod } from "../api/api";
import {
  isGetHook,
  isMutatorHook,
  type ClientHookParams,
  type FragnoClientMutatorData,
  type NewFragnoClientHookData,
} from "./client";
import type { FragnoClientApiError } from "./client-error";

export type StoreData<TOutputSchema extends StandardSchemaV1, TErrorCodes extends string> = {
  loading: boolean;
  error?: FragnoClientApiError<TErrorCodes>;
  data?: StandardSchemaV1.InferOutput<TOutputSchema>;
};

export type FragnoVanillaListeners<
  T extends NewFragnoClientHookData<"GET", string, StandardSchemaV1, string>,
> = (params?: ClientHookParams<T["route"]["path"], string | ReadableAtom<string>>) => {
  listen: (callback: Parameters<ReturnType<T["store"]>["listen"]>[0]) => void;
  subscribe: (callback: Parameters<ReturnType<T["store"]>["subscribe"]>[0]) => void;
  get: () => StoreData<
    NonNullable<T["route"]["outputSchema"]>,
    NonNullable<T["route"]["errorCodes"]>[number]
  >;
  refetch: () => void;
};

function createVanillaListeners<
  T extends NewFragnoClientHookData<"GET", string, StandardSchemaV1, string>,
>(hook: T): FragnoVanillaListeners<T> {
  return (params?: ClientHookParams<T["route"]["path"], string | ReadableAtom<string>>) => {
    const store = hook.store(params ?? {});
    return {
      listen: (callback: Parameters<ReturnType<T["store"]>["listen"]>[0]) => {
        store.listen(callback);
      },
      subscribe: (callback: Parameters<ReturnType<T["store"]>["subscribe"]>[0]) => {
        store.subscribe(callback);
      },
      refetch: () => {
        return store.revalidate();
      },
      get: () => {
        const { loading, error, data } = store.get();
        return {
          loading,
          error,
          data,
        };
      },
    };
  };
}

export type FragnoVanillaMutator<
  T extends FragnoClientMutatorData<
    NonGetHTTPMethod,
    string,
    StandardSchemaV1,
    StandardSchemaV1,
    string
  >,
> = () => {
  subscribe: (
    callback: (value: {
      loading?: boolean;
      error?: FragnoClientApiError<NonNullable<T["route"]["errorCodes"]>[number]>;
      data?: StandardSchemaV1.InferOutput<NonNullable<T["route"]["outputSchema"]>>;
    }) => void,
  ) => void;
  get: () => StoreData<
    NonNullable<T["route"]["outputSchema"]>,
    NonNullable<T["route"]["errorCodes"]>[number]
  >;
  mutate: ({
    body,
    params,
  }: {
    body: StandardSchemaV1.InferInput<NonNullable<T["route"]["inputSchema"]>>;
    params: ClientHookParams<T["route"]["path"], string | ReadableAtom<string>>;
  }) => Promise<StandardSchemaV1.InferOutput<NonNullable<T["route"]["outputSchema"]>>>;
};

function createVanillaMutator<
  T extends FragnoClientMutatorData<
    NonGetHTTPMethod,
    string,
    StandardSchemaV1,
    StandardSchemaV1,
    string
  >,
>(hook: T): FragnoVanillaMutator<T> {
  return () => {
    const store = hook.mutatorStore;
    return {
      subscribe: (callback) => {
        store.subscribe(callback);
      },
      get: () => {
        const { loading, error, data } = store.get();
        return {
          loading: loading ?? false,
          error,
          data,
        };
      },
      mutate: ({ body, params }) => {
        return store.mutate({ body, params });
      },
    };
  };
}

export function useFragno<
  T extends Record<
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | NewFragnoClientHookData<"GET", string, StandardSchemaV1<any, any>, string>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | FragnoClientMutatorData<NonGetHTTPMethod, string, any, any, string>
  >,
>(
  clientObj: T,
): {
  [K in keyof T]: T[K] extends NewFragnoClientHookData<"GET", string, infer _O, infer _E>
    ? FragnoVanillaListeners<T[K]>
    : T[K] extends FragnoClientMutatorData<NonGetHTTPMethod, string, infer _I, infer _O, infer _E>
      ? FragnoVanillaMutator<T[K]>
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
