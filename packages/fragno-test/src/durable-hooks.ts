import { createDurableHooksProcessor } from "@fragno-dev/db/dispatchers/node";

import type { AnyFragnoInstantiatedFragment } from "@fragno-dev/core";
import { type AnyFragnoInstantiatedDatabaseFragment } from "@fragno-dev/db";

export type DrainDurableHooksMode = "untilIdle" | "singlePass";

export type DrainDurableHooksOptions = {
  mode?: DrainDurableHooksMode;
};

export async function drainDurableHooks(
  fragment: AnyFragnoInstantiatedFragment,
  options: DrainDurableHooksOptions = {},
): Promise<void> {
  const internal = fragment.$internal as { durableHooksToken?: object } | undefined;
  if (!internal?.durableHooksToken) {
    return;
  }
  const dispatcher = createDurableHooksProcessor([
    fragment as AnyFragnoInstantiatedDatabaseFragment,
  ]);
  if (options.mode === "singlePass") {
    await dispatcher.wake();
    return;
  }
  await dispatcher.drain();
}
