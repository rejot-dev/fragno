import {
  createDurableHooksProcessor,
  type AnyFragnoInstantiatedDatabaseFragment,
} from "@fragno-dev/db";
import type { AnyFragnoInstantiatedFragment } from "@fragno-dev/core";

export async function drainDurableHooks(fragment: AnyFragnoInstantiatedFragment): Promise<void> {
  const processor = createDurableHooksProcessor(fragment as AnyFragnoInstantiatedDatabaseFragment);
  if (!processor) {
    return;
  }
  await processor.drain();
}
