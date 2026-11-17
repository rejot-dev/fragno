import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { readBrowserMsUsed } from "@fragno-dev/cloudflare-fragment/browser-run";

import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { usageBillingForScope } from "@/fragno/billing/usage-billing";

/**
 * Called before a Quick Action reaches Cloudflare, so work that cannot be billed is refused before
 * Cloudflare charges for it. Returns how to record the browser time its response reports.
 */
export type BrowserRunMeter = (action: string) => (headers: Headers) => Promise<void>;

/**
 * Attributes Browser Run time to the scope's root owner, in the milliseconds Cloudflare bills by.
 * Like Reson8, a synchronous producer without an outbox: a recording failure fails the call.
 */
export function createBrowserRunMeter({
  runtime,
  scope,
  nowEpochMs,
}: {
  runtime: Pick<BackofficeRuntimeServices, "objects" | "config">;
  scope: BackofficeContextScope;
  nowEpochMs: () => number;
}): BrowserRunMeter {
  return (action) => {
    // Resolved per call rather than per context, since most contexts never run a Quick Action.
    const billing = usageBillingForScope(runtime, scope);
    return async (headers) => {
      const browserMsUsed = readBrowserMsUsed(headers);
      if (billing.kind === "system") {
        return;
      }
      await billing.recordEvent(
        {
          id: `browser-run-${action}:${crypto.randomUUID()}`,
          scope,
          source: "browser-run",
          eventType: `${action}.completed`,
          occurredAt: new Date(nowEpochMs()).toISOString(),
          measurements: [
            { meter: "browser-run.time", unit: "millisecond", quantity: Math.ceil(browserMsUsed) },
          ],
        },
        { propagationContext: null },
      );
    };
  };
}
