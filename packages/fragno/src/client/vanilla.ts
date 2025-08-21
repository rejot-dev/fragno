import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { NonGetHTTPMethod } from "../api/api";
import {
  isGetHook,
  isMutatorHook,
  type ClientHookParams,
  type FragnoClientMutatorData,
  type NewFragnoClientHookData,
} from "./client";

export type VanillaHook<T extends NewFragnoClientHookData<"GET", string, StandardSchemaV1>> = (
  params?: ClientHookParams<T["route"]["path"], string>,
) => Promise<StandardSchemaV1.InferOutput<NonNullable<T["route"]["outputSchema"]>>>;

export type VanillaMutator<
  T extends FragnoClientMutatorData<NonGetHTTPMethod, string, StandardSchemaV1, StandardSchemaV1>,
> = (
  body: StandardSchemaV1.InferInput<NonNullable<T["route"]["inputSchema"]>>,
  params?: ClientHookParams<T["route"]["path"], string>,
) => Promise<StandardSchemaV1.InferOutput<NonNullable<T["route"]["outputSchema"]>>>;

// Server-side hook for any framework
export type VanillaServerHook<T extends NewFragnoClientHookData<"GET", string, StandardSchemaV1>> =
  (
    params?: ClientHookParams<T["route"]["path"], string>,
  ) => Promise<StandardSchemaV1.InferOutput<NonNullable<T["route"]["outputSchema"]>>>;

// Helper function to create a server-side hook from a GET hook
function createVanillaServerHook<
  T extends NewFragnoClientHookData<"GET", string, StandardSchemaV1>,
>(hook: T): VanillaServerHook<T> {
  return async (params?: ClientHookParams<T["route"]["path"], string>) => {
    return hook.query(params || {});
  };
}

// Helper function to create a mutator from a mutator hook
function createVanillaMutator<
  T extends FragnoClientMutatorData<NonGetHTTPMethod, string, StandardSchemaV1, StandardSchemaV1>,
>(hook: T): VanillaMutator<T> {
  return async (
    body: StandardSchemaV1.InferInput<NonNullable<T["route"]["inputSchema"]>>,
    params?: ClientHookParams<T["route"]["path"], string>,
  ) => {
    return hook.mutate(body, params || {});
  };
}

// Helper type to transform a single hook/mutator
type TransformServerHook<T> =
  T extends NewFragnoClientHookData<"GET", string, infer O>
    ? VanillaServerHook<NewFragnoClientHookData<"GET", string, O>>
    : T extends FragnoClientMutatorData<infer M, string, infer I, infer O>
      ? VanillaMutator<FragnoClientMutatorData<M, string, I, O>>
      : never;

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
  [K in keyof T]: TransformServerHook<T[K]>;
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = {} as any; // We need one any cast here due to TypeScript's limitations with mapped types

  for (const key in clientObj) {
    if (!Object.prototype.hasOwnProperty.call(clientObj, key)) {
      continue;
    }

    const hook = clientObj[key];
    if (isGetHook(hook)) {
      result[key] = createVanillaServerHook(hook);
    } else if (isMutatorHook(hook)) {
      result[key] = createVanillaMutator(hook);
    } else {
      throw new Error(`Hook ${key} doesn't match either GET or mutator type guard`);
    }
  }

  return result;
}
