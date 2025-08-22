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

export type FragnoVanillaListeners<
  T extends NewFragnoClientHookData<"GET", string, StandardSchemaV1>,
> = (params?: ClientHookParams<T["route"]["path"], string | ReadableAtom<string>>) => {
  listen: (callback: Parameters<ReturnType<T["store"]>["listen"]>[0]) => void;
  subscribe: (callback: Parameters<ReturnType<T["store"]>["subscribe"]>[0]) => void;
  getData: () => StandardSchemaV1.InferOutput<NonNullable<T["route"]["outputSchema"]>>;
  refetch: () => void;
};

function createVanillaListeners<T extends NewFragnoClientHookData<"GET", string, StandardSchemaV1>>(
  hook: T,
): FragnoVanillaListeners<T> {
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
      getData: () => {
        return store.get().data;
      },
    };
  };
}

export type FragnoVanillaMutator<
  T extends FragnoClientMutatorData<NonGetHTTPMethod, string, StandardSchemaV1, StandardSchemaV1>,
> = (
  body: StandardSchemaV1.InferInput<NonNullable<T["route"]["inputSchema"]>>,
  params?: ClientHookParams<T["route"]["path"], string | ReadableAtom<string>>,
) => Promise<StandardSchemaV1.InferOutput<NonNullable<T["route"]["outputSchema"]>>>;

function createVanillaMutator<
  T extends FragnoClientMutatorData<NonGetHTTPMethod, string, StandardSchemaV1, StandardSchemaV1>,
>(hook: T): FragnoVanillaMutator<T> {
  return (body, params) => {
    return hook.mutateQuery(body, params ?? {});
  };
}

export function useVanilla<
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
  [K in keyof T]: T[K] extends NewFragnoClientHookData<"GET", string, infer _O>
    ? FragnoVanillaListeners<T[K]>
    : T[K] extends FragnoClientMutatorData<NonGetHTTPMethod, string, infer _I, infer _O>
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
