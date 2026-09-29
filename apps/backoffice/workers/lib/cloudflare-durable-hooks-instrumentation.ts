import type { DurableHookNotification, DurableHooksInstrumentation } from "@fragno-dev/db/hooks";
import { tracing } from "cloudflare:workers";

import { executeLoggedBackofficeDurableHookAttempt } from "@/backoffice-runtime/runtime-instrumentation";

let customSpanWarningEmitted = false;

const toErrorFields = (error: unknown) =>
  error instanceof Error
    ? { errorName: error.name, errorMessage: error.message }
    : { errorName: "UnknownError", errorMessage: String(error) };

const warnCustomSpanUnavailable = (reason: string, error?: unknown) => {
  if (import.meta.env?.MODE !== "development" || customSpanWarningEmitted) {
    return;
  }

  customSpanWarningEmitted = true;
  console.warn("Fragno durable hook custom spans are unavailable", {
    reason,
    ...(error === undefined ? {} : toErrorFields(error)),
  });
};

/**
 * Emits one Cloudflare custom span and searchable lifecycle logs for every durable-hook attempt.
 *
 * Cloudflare does not expose custom span IDs, so capture falls back to any W3C carrier already
 * present in Fragno's ambient request context. The attempt span is still parented to the active
 * fetch, RPC, or alarm invocation.
 */
export const cloudflareDurableHooksInstrumentation: DurableHooksInstrumentation = {
  captureContext: () => null,
  runNotify: async (notification: DurableHookNotification, execute) => {
    let enteredSpan = false;
    try {
      const result = tracing.enterSpan("fragno.durable_hooks.notify", (span) => {
        enteredSpan = true;
        if (!span.isTraced) {
          warnCustomSpanUnavailable("active invocation is not being traced");
        }

        span.setAttribute("fragno.hook.namespace", notification.namespace);
        span.setAttribute("fragno.hook.correlation_id", notification.correlationId);
        span.setAttribute("fragno.hook.notify.source", notification.source);
        span.setAttribute("fragno.hook.notify.cross_namespace", notification.crossNamespace);
        span.setAttribute("fragno.hook.notify.queued", notification.queued);
        if (notification.route) {
          span.setAttribute("fragno.hook.notify.route", notification.route);
        }

        return execute();
      });

      if (enteredSpan) {
        return await result;
      }

      warnCustomSpanUnavailable("tracing.enterSpan() skipped its callback");
    } catch (error) {
      if (enteredSpan) {
        throw error;
      }
      warnCustomSpanUnavailable("tracing.enterSpan() threw before entering its callback", error);
    }

    // Notification must remain available even when a runtime cannot create custom spans.
    return await execute();
  },
  runAttempt: async (attempt, execute) => {
    let enteredSpan = false;
    try {
      const result = tracing.enterSpan("fragno.durable_hook.attempt", (span) => {
        enteredSpan = true;
        if (!span.isTraced) {
          warnCustomSpanUnavailable("active invocation is not being traced");
        }

        span.setAttribute("fragno.hook.namespace", attempt.namespace);
        span.setAttribute("fragno.hook.name", attempt.hookName);
        span.setAttribute("fragno.hook.id", attempt.hookId.toString());
        span.setAttribute("fragno.hook.correlation_id", attempt.idempotencyKey);
        span.setAttribute("fragno.hook.attempt", attempt.attempt);
        span.setAttribute("fragno.hook.max_attempts", attempt.maxAttempts);
        span.setAttribute(
          "fragno.hook.has_propagation_context",
          attempt.propagationContext !== null,
        );

        return executeLoggedBackofficeDurableHookAttempt(attempt, execute);
      });

      if (enteredSpan) {
        return await result;
      }

      warnCustomSpanUnavailable("tracing.enterSpan() skipped its callback");
    } catch (error) {
      if (enteredSpan) {
        throw error;
      }
      warnCustomSpanUnavailable("tracing.enterSpan() threw before entering its callback", error);
    }

    // Hook execution must remain available even when a runtime cannot create custom spans.
    return await executeLoggedBackofficeDurableHookAttempt(attempt, execute);
  },
};
