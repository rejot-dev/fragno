import { useStore } from "@nanostores/vue";
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
import type { ShallowRef } from "vue";
import type { FetcherValue } from "@nanostores/query";

export type FragnoVueHook<T extends NewFragnoClientHookData<"GET", string, StandardSchemaV1>> = (
  params?: ClientHookParams<T["route"]["path"], string | ReadableAtom<string>>,
) => ShallowRef<
  FetcherValue<StandardSchemaV1.InferOutput<NonNullable<T["route"]["outputSchema"]>>>
>;

export type FragnoVueMutator<
  T extends FragnoClientMutatorData<NonGetHTTPMethod, string, StandardSchemaV1, StandardSchemaV1>,
> = (
  body: StandardSchemaV1.InferInput<NonNullable<T["route"]["inputSchema"]>>,
  params?: ClientHookParams<T["route"]["path"], string | ReadableAtom<string>>,
) => Promise<StandardSchemaV1.InferOutput<NonNullable<T["route"]["outputSchema"]>>>;

// Helper function to create a Vue composable from a GET hook
function createVueHook<T extends NewFragnoClientHookData<"GET", string, StandardSchemaV1>>(
  hook: T,
): FragnoVueHook<T> {
  return (params?: ClientHookParams<T["route"]["path"], string | ReadableAtom<string>>) => {
    const paramsObj: {
      pathParams?: Record<string, string | ReadableAtom<string>>;
      queryParams?: Record<string, string | ReadableAtom<string>>;
    } = params ?? {};
    const store = hook.store(paramsObj);

    return useStore(store);
  };
}

// Helper function to create a Vue mutator from a mutator hook
function createVueMutator<
  T extends FragnoClientMutatorData<NonGetHTTPMethod, string, StandardSchemaV1, StandardSchemaV1>,
>(hook: T): FragnoVueMutator<T> {
  return async (
    body: StandardSchemaV1.InferInput<NonNullable<T["route"]["inputSchema"]>>,
    params?: ClientHookParams<T["route"]["path"], string | ReadableAtom<string>>,
  ) => {
    return hook.mutate(body, params as ClientHookParams<string, string>);
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
    ? FragnoVueHook<NewFragnoClientHookData<"GET", string, O>>
    : T extends FragnoClientMutatorData<infer M, string, infer I, infer O>
      ? FragnoVueMutator<FragnoClientMutatorData<M, string, I, O>>
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
      result[key] = createVueHook(hook);
    } else if (isMutatorHook(hook)) {
      result[key] = createVueMutator(hook);
    } else {
      throw new Error(`Hook ${key} doesn't match either GET or mutator type guard`);
    }
  }

  return result;
}
