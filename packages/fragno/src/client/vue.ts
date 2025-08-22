import { useStore } from "@nanostores/vue";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { atom, type ReadableAtom, type WritableAtom } from "nanostores";
import type { Ref } from "vue";
import { computed, watch } from "vue";
import type { NonGetHTTPMethod } from "../api/api";
import {
  isGetHook,
  isMutatorHook,
  type ClientHookParams,
  type FragnoClientMutatorData,
  type NewFragnoClientHookData,
} from "./client";

export type FragnoVueHook<T extends NewFragnoClientHookData<"GET", string, StandardSchemaV1>> = (
  params?: ClientHookParams<T["route"]["path"], string | Ref<string>>,
) => {
  data: Ref<StandardSchemaV1.InferOutput<NonNullable<T["route"]["outputSchema"]>> | undefined>;
  loading: Ref<boolean>;
  error: Ref<Error | undefined>;
};

export type FragnoVueMutator<
  T extends FragnoClientMutatorData<NonGetHTTPMethod, string, StandardSchemaV1, StandardSchemaV1>,
> = (
  body: StandardSchemaV1.InferInput<NonNullable<T["route"]["inputSchema"]>>,
  params?: ClientHookParams<T["route"]["path"], string | Ref<string>>,
) => Promise<StandardSchemaV1.InferOutput<NonNullable<T["route"]["outputSchema"]>>>;

// Helper function to create a Vue composable from a GET hook
// We want 1 store per hook, so on updates to params, we need to update the store instead of creating a new one.
// Nanostores only works with atoms (or strings), so we need to convert vue refs to atoms.
function createVueHook<T extends NewFragnoClientHookData<"GET", string, StandardSchemaV1>>(
  hook: T,
): FragnoVueHook<T> {
  return (
    params?: ClientHookParams<T["route"]["path"], string | Ref<string> | ReadableAtom<string>>,
  ) => {
    const paramsObj: {
      pathParams?: Record<string, string | Ref<string> | ReadableAtom<string>>;
      queryParams?: Record<string, string | Ref<string> | ReadableAtom<string>>;
    } = params ?? {};

    // Create individual atoms for each parameter value
    const pathParamsAtoms: Record<string, WritableAtom<string>> = {};
    const queryParamsAtoms: Record<string, WritableAtom<string>> = {};

    // Initialize atoms for existing params
    for (const [key, _] of Object.entries(paramsObj.pathParams ?? {})) {
      pathParamsAtoms[key] = atom();
    }

    for (const [key, _] of Object.entries(paramsObj.queryParams ?? {})) {
      queryParamsAtoms[key] = atom();
    }

    // TODO(Thies): This feels hacky, and should be improved.
    const normalizedParams = computed(() => {
      return {
        pathParams: paramsObj.pathParams
          ? Object.fromEntries(
              Object.entries(paramsObj.pathParams).map(([key, value]) => [
                key,
                typeof value === "string" ? value : value.value,
              ]),
            )
          : undefined,
        queryParams: paramsObj.queryParams
          ? Object.fromEntries(
              Object.entries(paramsObj.queryParams).map(([key, value]) => [
                key,
                typeof value === "string" ? value : value.value,
              ]),
            )
          : undefined,
      };
    });

    // Watch for changes in vue refs, and update the individual atoms with those values.
    watch(
      normalizedParams,
      (newParams) => {
        if (newParams.pathParams) {
          for (const [key, value] of Object.entries(newParams.pathParams)) {
            if (pathParamsAtoms[key]) {
              pathParamsAtoms[key].set(value ?? "");
            }
          }
        }
        if (newParams.queryParams) {
          for (const [key, value] of Object.entries(newParams.queryParams)) {
            if (queryParamsAtoms[key]) {
              queryParamsAtoms[key].set(value ?? "");
            }
          }
        }
      },
      { immediate: true },
    );

    // Now create a store, which updates whenever you change the path/query params.
    const store = hook.store({
      pathParams: pathParamsAtoms,
      queryParams: queryParamsAtoms,
    });
    const result = useStore(store);

    // To allow unwrapping of the return value, we need to create a computed value.
    return {
      data: computed(() => result.value.data),
      loading: computed(() => result.value.loading),
      error: computed(() => result.value.error),
    };
  };
}

// Helper function to create a Vue mutator from a mutator hook
function createVueMutator<
  T extends FragnoClientMutatorData<NonGetHTTPMethod, string, StandardSchemaV1, StandardSchemaV1>,
>(hook: T): FragnoVueMutator<T> {
  return async (
    body: StandardSchemaV1.InferInput<NonNullable<T["route"]["inputSchema"]>>,
    params?: ClientHookParams<T["route"]["path"], string | Ref<string>>,
  ) => {
    // Convert Ref<string> to string for the underlying hook
    const normalizedParams = params
      ? {
          pathParams:
            params && "pathParams" in params && params.pathParams
              ? (() => {
                  const entries = Object.entries(params.pathParams);
                  if (!entries.length) return undefined;
                  return Object.fromEntries(
                    entries.map(([key, value]) => [
                      key,
                      typeof value === "string" ? value : value.value,
                    ]),
                  );
                })()
              : undefined,
          queryParams:
            params && "queryParams" in params && params.queryParams
              ? (() => {
                  const entries = Object.entries(params.queryParams);
                  if (!entries.length) return undefined;
                  return Object.fromEntries(
                    entries.map(([key, value]) => [
                      key,
                      typeof value === "string" ? value : value.value,
                    ]),
                  );
                })()
              : undefined,
        }
      : undefined;

    return hook.mutateQuery(body, normalizedParams as ClientHookParams<string, string>);
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
