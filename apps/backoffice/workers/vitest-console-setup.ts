import { inject } from "vitest";

/*
 * The Cloudflare project runs with `disableConsoleIntercept` (see `vitest.cloudflare.config.ts`), so
 * console output goes to workerd's own stdout, which the pool relays to the terminal regardless of
 * Vitest's `silent` option. Backoffice's Durable Objects log every durable-hook lifecycle, which
 * turns a quiet run into thousands of lines. When Vitest discards console output anyway, discard
 * it here instead. `--silent=false` keeps the logs. `vitest.cloudflare.config.ts` provides the flag.
 */
const injectFlag = inject as (key: string) => boolean;
if (injectFlag("backofficeConsoleSilent")) {
  const silenced: (keyof Console)[] = [
    "log",
    "info",
    "debug",
    "warn",
    "error",
    "trace",
    "dir",
    "dirxml",
    "table",
    "group",
    "groupCollapsed",
    "groupEnd",
    "count",
    "countReset",
    "time",
    "timeEnd",
    "timeLog",
    "assert",
  ];
  for (const method of silenced) {
    Object.defineProperty(console, method, { value: () => {}, writable: true, configurable: true });
  }
}
