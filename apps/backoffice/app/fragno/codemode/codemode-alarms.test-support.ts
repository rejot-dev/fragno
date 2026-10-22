import { listDurableObjectIds, runDurableObjectAlarm } from "cloudflare:test";

import { env } from "cloudflare:workers";

/**
 * Runs every pending Codemode alarm. Codemode runs leave durable hooks for the alarm, and an alarm
 * that fires after a file's last test loads the main module while Vitest closes the worker, which
 * fails the run. Call it from afterAll in files that run code on Codemode objects.
 */
export async function drainCodemodeAlarms() {
  for (const id of await listDurableObjectIds(env.CODEMODE)) {
    while (await runDurableObjectAlarm(env.CODEMODE.get(id))) {
      // An alarm can schedule the next one, such as a hook's retry.
    }
  }
}
