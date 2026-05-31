import type { AnyFragnoInstantiatedDatabaseFragment } from "../mod";

export type DurableHooksFragmentInternal = {
  durableHooksToken?: object;
};

export function getDurableHooksToken(
  fragment: AnyFragnoInstantiatedDatabaseFragment,
): object | undefined {
  const internal = fragment.$internal as DurableHooksFragmentInternal | undefined;
  return internal?.durableHooksToken;
}

export function hasDurableHooksConfigured(
  fragment: AnyFragnoInstantiatedDatabaseFragment,
): boolean {
  return Boolean(getDurableHooksToken(fragment));
}
