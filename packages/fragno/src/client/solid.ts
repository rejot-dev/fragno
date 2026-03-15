import { atom, type ReadableAtom, type Store, type StoreValue } from "nanostores";
import type { Accessor } from "solid-js";
import { createEffect, onCleanup } from "solid-js";

import { useStore } from "@nanostores/solid";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { NonGetHTTPMethod } from "../api/api";
import type { MaybeExtractPathParamsOrWiden, QueryParamsHint } from "../api/internal/path";
import { isReadableAtom } from "../util/nanostores";
import type { InferOr } from "../util/types-util";
import {
  isGetHook,
  isMutatorHook,
  isStore,
  type FragnoClientHookData,
  type FragnoClientMutatorData,
  type FragnoStoreData,
  type FragnoStoreFactoryData,
  type FragnoStoreObjectData,
} from "./client";
import type { FragnoClientError } from "./client-error";

export type FragnoSolidHook<
  _TMethod extends "GET",
  TPath extends string,
  TOutputSchema extends StandardSchemaV1,
  TErrorCode extends string,
  TQueryParameters extends string,
> = (args?: {
  path?: MaybeExtractPathParamsOrWiden<TPath, string | Accessor<string> | ReadableAtom<string>>;
  query?: QueryParamsHint<TQueryParameters, string | Accessor<string> | ReadableAtom<string>>;
}) => {
  data: Accessor<InferOr<TOutputSchema, undefined>>;
  loading: Accessor<boolean>;
  error: Accessor<FragnoClientError<TErrorCode[number]> | undefined>;
};

export type FragnoSolidMutator<
  _TMethod extends NonGetHTTPMethod,
  TPath extends string,
  TInputSchema extends StandardSchemaV1 | undefined,
  TOutputSchema extends StandardSchemaV1 | undefined,
  TErrorCode extends string,
  TQueryParameters extends string,
> = () => {
  mutate: (args: {
    body?: InferOr<TInputSchema, undefined>;
    path?: MaybeExtractPathParamsOrWiden<TPath, string | Accessor<string> | ReadableAtom<string>>;
    query?: QueryParamsHint<TQueryParameters, string | Accessor<string> | ReadableAtom<string>>;
  }) => Promise<InferOr<TOutputSchema, undefined>>;
  loading: Accessor<boolean | undefined>;
  error: Accessor<FragnoClientError<TErrorCode[number]> | undefined>;
  data: Accessor<InferOr<TOutputSchema, undefined>>;
};

/**
 * Type guard to check if a value is a SolidJS Accessor.
 *
 * @private
 */
export function isAccessor(value: unknown): value is Accessor<string> {
  return typeof value === "function";
}

/**
 * Converts a SolidJS Accessor to a NanoStore Atom.
 *
 * This is used to convert SolidJS accessors to atoms, so that we can use them in the store.
 *
 * @private
 */
export function accessorToAtom<T>(accessor: Accessor<T>): ReadableAtom<T> {
  const a = atom(accessor());

  createEffect(() => {
    a.set(accessor());
  });

  return a;
}

// Helper function to create a SolidJS signal from a GET hook
// We want 1 store per hook, so on updates to params, we need to update the store instead of creating a new one.
// Nanostores only works with atoms (or strings), so we need to convert SolidJS accessors to atoms.
function createSolidHook<
  TMethod extends "GET",
  TPath extends string,
  TOutputSchema extends StandardSchemaV1,
  TErrorCode extends string,
  TQueryParameters extends string,
>(
  hook: FragnoClientHookData<TMethod, TPath, TOutputSchema, TErrorCode, TQueryParameters>,
): FragnoSolidHook<TMethod, TPath, TOutputSchema, TErrorCode, TQueryParameters> {
  return ({ path, query } = {}) => {
    const pathParams: Record<string, string | ReadableAtom<string>> = {};
    const queryParams: Record<string, string | ReadableAtom<string>> = {};

    for (const [key, value] of Object.entries(path ?? {})) {
      const v = value as string | Accessor<string> | ReadableAtom<string>;
      pathParams[key] = isAccessor(v) ? accessorToAtom(v) : v;
    }

    for (const [key, value] of Object.entries(query ?? {})) {
      const v = value as string | Accessor<string> | ReadableAtom<string>;
      queryParams[key] = isAccessor(v) ? accessorToAtom(v) : v;
    }

    const store = hook.store({
      path: pathParams as MaybeExtractPathParamsOrWiden<TPath, string | ReadableAtom<string>>,
      query: queryParams,
    });

    const storeValue = useStore(store);

    return {
      data: () => storeValue().data as InferOr<TOutputSchema, undefined>,
      loading: () => storeValue().loading,
      error: () => storeValue().error,
    };
  };
}

// Helper function to create a SolidJS mutator from a mutator hook
function createSolidMutator<
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
): FragnoSolidMutator<TMethod, TPath, TInputSchema, TOutputSchema, TErrorCode, TQueryParameters> {
  return () => {
    const store = useStore(hook.mutatorStore);

    // Create a wrapped mutate function that handles SolidJS accessors
    const mutate = async (args: {
      body?: InferOr<TInputSchema, undefined>;
      path?: MaybeExtractPathParamsOrWiden<TPath, string | Accessor<string> | ReadableAtom<string>>;
      query?: QueryParamsHint<TQueryParameters, string | Accessor<string> | ReadableAtom<string>>;
    }) => {
      const { body, path, query } = args;

      const pathParams: Record<string, string | ReadableAtom<string>> = {};
      const queryParams: Record<string, string | ReadableAtom<string>> = {};

      for (const [key, value] of Object.entries(path ?? {})) {
        const v = value as string | Accessor<string> | ReadableAtom<string>;
        // For mutations, we read the current value of the accessor
        pathParams[key] = isAccessor(v) ? v() : v;
      }

      for (const [key, value] of Object.entries(query ?? {})) {
        const v = value as string | Accessor<string> | ReadableAtom<string>;
        // For mutations, we read the current value of the accessor
        queryParams[key] = isAccessor(v) ? v() : v;
      }

      // Call the store's mutate function with normalized params
      return hook.mutatorStore.mutate({
        body,
        path: pathParams as MaybeExtractPathParamsOrWiden<TPath, string | ReadableAtom<string>>,
        query: queryParams,
      });
    };

    return {
      mutate,
      data: () => store().data as InferOr<TOutputSchema, undefined>,
      loading: () => store().loading,
      error: () => store().error,
    };
  };
}

type FragnoSolidStoreValue<T extends object> = T extends Store
  ? Accessor<StoreValue<T>>
  : {
      [K in keyof T]: T[K] extends Store ? Accessor<StoreValue<T[K]>> : T[K];
    };

type FragnoSolidStaticStore<T extends object> = T extends Store
  ? Accessor<StoreValue<T>>
  : () => {
      [K in keyof T]: T[K] extends Store ? Accessor<StoreValue<T[K]>> : T[K];
    };

export type FragnoSolidStore<TStore extends FragnoStoreData<object, unknown[]>> =
  TStore extends FragnoStoreFactoryData<infer T, infer TArgs>
    ? (...args: TArgs) => FragnoSolidStoreValue<T>
    : TStore extends FragnoStoreObjectData<infer T>
      ? FragnoSolidStaticStore<T>
      : never;

function unwrapSolidStoreValue<T extends object>(value: T): FragnoSolidStoreValue<T> {
  if (isReadableAtom(value)) {
    return useStore(value) as FragnoSolidStoreValue<T>;
  }

  // For objects containing atoms, wrap each atom property with useStore
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = {};

  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue;
    }

    const fieldValue = value[key];
    if (isReadableAtom(fieldValue)) {
      result[key] = useStore(fieldValue);
    } else {
      result[key] = fieldValue;
    }
  }

  return result as FragnoSolidStoreValue<T>;
}

function createSolidStore<const TStore extends FragnoStoreData<object, unknown[]>>(
  hook: TStore,
): FragnoSolidStore<TStore> {
  if ("obj" in hook) {
    if (isReadableAtom(hook.obj)) {
      return useStore(hook.obj) as FragnoSolidStore<TStore>;
    }

    return (() => unwrapSolidStoreValue(hook.obj)) as FragnoSolidStore<TStore>;
  }

  return ((...args: Parameters<typeof hook.factory>) => {
    const value = hook.factory(...args);
    const disposer = (value as { [Symbol.dispose]?: (() => void) | undefined })[Symbol.dispose];
    if (typeof disposer === "function") {
      onCleanup(() => {
        disposer.call(value);
      });
    }

    return unwrapSolidStoreValue(value);
  }) as FragnoSolidStore<TStore>;
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
    ? FragnoSolidHook<"GET", TPath, TOutputSchema, TErrorCode, TQueryParameters>
    : T[K] extends FragnoClientMutatorData<
          infer TMethod,
          infer TPath,
          infer TInput,
          infer TOutput,
          infer TError,
          infer TQueryParameters
        >
      ? FragnoSolidMutator<TMethod, TPath, TInput, TOutput, TError, TQueryParameters>
      : T[K] extends FragnoStoreData<object, unknown[]>
        ? FragnoSolidStore<T[K]>
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
      result[key] = createSolidHook(hook);
    } else if (isMutatorHook(hook)) {
      result[key] = createSolidMutator(hook);
    } else if (isStore(hook)) {
      result[key] = createSolidStore(hook);
    } else {
      // Pass through non-hook values unchanged
      result[key] = hook;
    }
  }

  return result;
}
