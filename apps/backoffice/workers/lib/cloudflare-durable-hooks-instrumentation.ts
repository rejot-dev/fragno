import { tracing } from "cloudflare:workers";

import type { DurableHooksInstrumentation } from "@fragno-dev/db";

/**
 * Emits one Cloudflare custom span for every durable hook processing attempt.
 *
 * Cloudflare does not currently expose span IDs, so context capture falls back
 * to Fragno's ambient W3C carrier. The attempt span still nests under the
 * active fetch, RPC, or alarm invocation.
 */
export const cloudflareDurableHooksInstrumentation: DurableHooksInstrumentation = {
  captureContext: () => null,
  runAttempt: async (attempt, execute) => {
    let enteredSpan = false;
    try {
      const result = tracing.enterSpan("fragno.durable_hook.attempt", (span) => {
        enteredSpan = true;
        span.setAttribute("fragno.hook.namespace", attempt.namespace);
        span.setAttribute("fragno.hook.name", attempt.hookName);
        span.setAttribute("fragno.hook.id", attempt.hookId.toString());
        span.setAttribute("fragno.hook.attempt", attempt.attempt);
        span.setAttribute("fragno.hook.max_attempts", attempt.maxAttempts);
        span.setAttribute(
          "fragno.hook.has_propagation_context",
          attempt.propagationContext !== null,
        );

        return execute();
      });

      if (enteredSpan) {
        return await result;
      }
    } catch (error) {
      if (enteredSpan) {
        throw error;
      }
    }

    // Observability must not prevent hooks from running in runtimes without custom-span support.
    return await execute();
  },
};
