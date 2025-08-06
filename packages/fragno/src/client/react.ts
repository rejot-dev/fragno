import { useStore } from "@nanostores/react";
import type { FragnoClientHook } from "./client";
import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * React adapter for Fragno client hooks
 * Converts a generic FragnoClientHook into a React hook
 */
export function createReactHook<TOutputSchema extends StandardSchemaV1 | undefined>(
  clientHook: FragnoClientHook<TOutputSchema>,
) {
  return function useQuery() {
    const { data, loading, error } = useStore(clientHook.store);

    return {
      data,
      loading,
      error,
      refetch: clientHook.store.revalidate,
      mutate: clientHook.store.mutate,
    };
  };
}

/**
 * Higher-order function to create multiple React hooks from client hooks
 */
export function createReactHooks<
  T extends Record<string, FragnoClientHook<StandardSchemaV1 | undefined>>,
>(
  clientHooks: T,
): {
  [K in keyof T]: ReturnType<typeof createReactHook>;
} {
  const reactHooks: Record<string, ReturnType<typeof createReactHook>> = {};

  for (const [key, clientHook] of Object.entries(clientHooks)) {
    reactHooks[key] = createReactHook(clientHook);
  }

  return reactHooks as {
    [K in keyof T]: ReturnType<typeof createReactHook>;
  };
}
