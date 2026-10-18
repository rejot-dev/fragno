import { closeSync, openSync, writeFileSync } from "node:fs";
import { threadId } from "node:worker_threads";

import type { NodeRuntimeObjectContext } from "../../runtime/node-runtime-object";

/** Cleanup writes through live object storage; the next activation must recover its committed marker. */
export function createLifecycleObject({ state, onShutdown }: NodeRuntimeObjectContext) {
  const sql = state.storage.sql;
  void state.blockConcurrencyWhile(async () => {
    sql.exec("CREATE TABLE IF NOT EXISTS lifecycle (thread_id INTEGER NOT NULL)");
  });
  onShutdown(async () => {
    await Promise.resolve();
    await state.storage.transaction(async () => {
      sql.exec("INSERT INTO lifecycle VALUES (?)", threadId);
      const closed = (await state.storage.get<number>("closed")) ?? 0;
      await state.storage.put("closed", closed + 1);
    });
  });
  return {
    async fetch(_request: Request) {
      return Response.json({
        threadId,
        closed: (await state.storage.get<number>("closed")) ?? 0,
        cleanupThreads: sql
          .exec<{ thread_id: number }>("SELECT thread_id FROM lifecycle")
          .toArray()
          .map((row) => row.thread_id),
      });
    },
  };
}

/** Failed initialization must close worker-local resources rather than leak them with the activation. */
export function createFailingLifecycleObject({
  input,
  state,
  onShutdown,
}: NodeRuntimeObjectContext<{
  cleanupPath: string;
}>) {
  const descriptor = openSync(input.cleanupPath, "wx");
  onShutdown(() => {
    closeSync(descriptor);
    writeFileSync(input.cleanupPath, "closed");
  });
  void state.blockConcurrencyWhile(async () => {
    throw new Error("NODE_LIFECYCLE_INITIALIZATION_FAILED");
  });
  return {
    fetch(_request: Request) {
      return new Response("ready");
    },
  };
}
