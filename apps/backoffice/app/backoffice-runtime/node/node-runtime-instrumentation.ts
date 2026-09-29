import type { DurableHookPropagationContext } from "@fragno-dev/db/hooks";

import { context, propagation, ROOT_CONTEXT, type Context } from "@opentelemetry/api";

import {
  backofficeDatabaseTransactionSpanName,
  backofficeFragmentInitializationSpanName,
  executeLoggedBackofficeDurableHookAttempt,
  type BackofficeRuntimeInstrumentation,
} from "../runtime-instrumentation";
import { runNodeOpenTelemetrySpan } from "./node-opentelemetry-span";

function captureNodeTracePropagationContext(): DurableHookPropagationContext | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);

  const traceparent = carrier.traceparent;
  if (!traceparent) {
    return null;
  }

  const tracestate = carrier.tracestate;
  return tracestate ? { traceparent, tracestate } : { traceparent };
}

function extractNodeTracePropagationContext(
  carrier: DurableHookPropagationContext | null,
): Context {
  return carrier ? propagation.extract(ROOT_CONTEXT, carrier) : ROOT_CONTEXT;
}

/** Instruments Node Fragment operations and restores W3C context for durable-hook attempts. */
export const nodeBackofficeRuntimeInstrumentation: BackofficeRuntimeInstrumentation = {
  databaseTransactions: {
    run(transaction, execute) {
      const transactionName = transaction.transactionName;
      if (!transactionName || transaction.requestSource === "stream") {
        return execute();
      }

      return runNodeOpenTelemetrySpan(
        backofficeDatabaseTransactionSpanName(transaction),
        (span) => {
          span.setAttribute("fragno.db.transaction.kind", transaction.transactionKind);
          span.setAttribute("fragno.db.transaction.name", transactionName);
          span.setAttribute("fragno.db.request.source", transaction.requestSource);
          if (transaction.idempotencyKey) {
            span.setAttribute("fragno.db.transaction.idempotency_key", transaction.idempotencyKey);
          }
          if (transaction.fragmentName) {
            span.setAttribute("fragno.db.fragment.name", transaction.fragmentName);
          }
          if (transaction.callback) {
            span.setAttribute("fragno.db.transaction.callback", transaction.callback);
          }
          return execute();
        },
      );
    },
  },
  durableHooks: {
    captureContext: captureNodeTracePropagationContext,
    runNotify: async (notification, execute) =>
      await runNodeOpenTelemetrySpan("fragno.durable_hooks.notify", async (span) => {
        span.setAttribute("fragno.hook.namespace", notification.namespace);
        span.setAttribute("fragno.hook.correlation_id", notification.correlationId);
        span.setAttribute("fragno.hook.notify.source", notification.source);
        span.setAttribute("fragno.hook.notify.cross_namespace", notification.crossNamespace);
        span.setAttribute("fragno.hook.notify.queued", notification.queued);
        if (notification.route) {
          span.setAttribute("fragno.hook.notify.route", notification.route);
        }
        return await execute();
      }),
    runAttempt: async (attempt, execute) => {
      const parentContext = extractNodeTracePropagationContext(attempt.propagationContext);
      return await context.with(
        parentContext,
        async () =>
          await runNodeOpenTelemetrySpan("fragno.durable_hook.attempt", async (span) => {
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

            return await executeLoggedBackofficeDurableHookAttempt(attempt, execute);
          }),
      );
    },
  },
  fragmentInitialization: {
    run(initialization, execute) {
      return runNodeOpenTelemetrySpan(
        backofficeFragmentInitializationSpanName(initialization),
        (span) => {
          span.setAttribute("fragno.runtime.host.name", initialization.hostName);
          span.setAttribute("fragno.runtime.initialization.phase", initialization.phase);
          if (initialization.phase === "migrate") {
            span.setAttribute("fragno.db.fragment.name", initialization.fragmentName);
          }
          return execute();
        },
      );
    },
  },
};
