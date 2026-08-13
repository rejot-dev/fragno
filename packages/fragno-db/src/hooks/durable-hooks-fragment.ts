import type { AnyFragnoInstantiatedDatabaseFragment } from "../mod";
import type { DurableHooksRuntimeToken } from "./durable-hooks-runtime";

export type DurableHooksFragmentInternal = {
  durableHooksToken?: DurableHooksRuntimeToken;
};

export function getDurableHooksToken(
  fragment: AnyFragnoInstantiatedDatabaseFragment,
): DurableHooksRuntimeToken | undefined {
  const internal = fragment.$internal as DurableHooksFragmentInternal | undefined;
  return internal?.durableHooksToken;
}

export function hasDurableHooksConfigured(
  fragment: AnyFragnoInstantiatedDatabaseFragment,
): boolean {
  return Boolean(getDurableHooksToken(fragment));
}
