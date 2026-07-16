import { createDurableHooksProcessor } from "@fragno-dev/db/dispatchers/node";

import type { AnyFragnoInstantiatedFragment } from "@fragno-dev/core";
import { type AnyFragnoInstantiatedDatabaseFragment } from "@fragno-dev/db";

export type DrainDurableHooksMode = "untilIdle" | "singlePass";

export type DrainDurableHooksOptions = {
  mode?: DrainDurableHooksMode;
};

export async function drainDurableHooks(
  fragmentOrFragments: AnyFragnoInstantiatedFragment | readonly AnyFragnoInstantiatedFragment[],
  options: DrainDurableHooksOptions = {},
): Promise<void> {
  const fragments = Array.isArray(fragmentOrFragments)
    ? fragmentOrFragments
    : [fragmentOrFragments];
  const fragmentsWithDurableHooks = fragments.filter((fragment) => {
    const internal = fragment.$internal as { durableHooksToken?: object } | undefined;
    return Boolean(internal?.durableHooksToken);
  }) as AnyFragnoInstantiatedDatabaseFragment[];
  if (fragmentsWithDurableHooks.length === 0) {
    return;
  }
  const dispatcher = createDurableHooksProcessor(fragmentsWithDurableHooks);
  if (options.mode === "singlePass") {
    await dispatcher.wake();
    return;
  }
  await dispatcher.drain();
}
