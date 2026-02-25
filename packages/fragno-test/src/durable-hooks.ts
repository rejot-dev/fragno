import { type AnyFragnoInstantiatedDatabaseFragment } from "@fragno-dev/db";
import { createDurableHooksProcessor } from "@fragno-dev/db/dispatchers/node";
import type { AnyFragnoInstantiatedFragment } from "@fragno-dev/core";

export async function drainDurableHooks(fragment: AnyFragnoInstantiatedFragment): Promise<void> {
  const internal = fragment.$internal as { durableHooksToken?: object } | undefined;
  if (!internal?.durableHooksToken) {
    return;
  }
  const dispatcher = createDurableHooksProcessor([
    fragment as AnyFragnoInstantiatedDatabaseFragment,
  ]);
  await dispatcher.drain();
}
