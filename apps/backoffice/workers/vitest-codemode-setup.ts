import { listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { afterAll } from "vitest";

import { env } from "cloudflare:workers";

import type { Automations } from "./automations.do";
import type { Codemode } from "./codemode.do";

// Run completion commits hooks, not their effects. Let those effects finish before Vitest closes
// its module-resolution RPC, including the Automations events emitted by non-workflow runs.
afterAll(async function drainCodemodeRunHooks() {
  const namespaces: DurableObjectNamespace<Codemode | Automations>[] = [
    env.CODEMODE,
    env.AUTOMATIONS,
  ];
  for (const namespace of namespaces) {
    for (const id of await listDurableObjectIds(namespace)) {
      await runInDurableObject(namespace.get(id), async (object, state) => {
        // Calling the handler also joins an alarm already running with no scheduled wake-up.
        await object.alarm();
        let nextAlarm = await state.storage.getAlarm();
        while (nextAlarm !== null && nextAlarm <= Date.now()) {
          await object.alarm();
          nextAlarm = await state.storage.getAlarm();
        }
      });
    }
  }
});
