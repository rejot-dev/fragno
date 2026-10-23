import { listDurableObjectIds, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";

import { env } from "cloudflare:workers";

/**
 * Runs every due Codemode alarm. Codemode runs leave durable hooks for the alarm, and an alarm
 * that fires after a file's last test loads the main module while Vitest closes the worker, which
 * fails the run. Call it from afterAll in files that run code on Codemode objects.
 *
 * Alarms in the future, such as a run's tool-call expiry days away, are left alone: they cannot
 * fire before the worker closes, and running one early processes nothing and re-arms it.
 */
export async function drainCodemodeAlarms() {
  for (const id of await listDurableObjectIds(env.CODEMODE)) {
    const stub = env.CODEMODE.get(id);
    while (await hasDueAlarm(stub)) {
      // An alarm can schedule the next one, such as a hook's retry.
      await runDurableObjectAlarm(stub);
    }
  }
}

async function hasDueAlarm(stub: DurableObjectStub) {
  const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
  return alarm !== null && alarm <= Date.now();
}
