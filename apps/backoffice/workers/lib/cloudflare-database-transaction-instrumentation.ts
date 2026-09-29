import type {
  DatabaseTransactionInstrumentation,
  DatabaseTransactionInstrumentationContext,
} from "@fragno-dev/db/transaction-instrumentation";
import { tracing } from "cloudflare:workers";

import { backofficeDatabaseTransactionSpanName } from "@/backoffice-runtime/runtime-instrumentation";

const runCloudflareTransactionSpan = <T>(
  context: DatabaseTransactionInstrumentationContext,
  execute: () => T,
): T => {
  if (!context.transactionName || context.requestSource === "stream") {
    return execute();
  }

  let enteredSpan = false;
  try {
    const result = tracing.enterSpan(backofficeDatabaseTransactionSpanName(context), (span) => {
      enteredSpan = true;
      span.setAttribute("fragno.db.transaction.kind", context.transactionKind);
      span.setAttribute("fragno.db.transaction.name", context.transactionName);
      span.setAttribute("fragno.db.request.source", context.requestSource);
      if (context.idempotencyKey) {
        span.setAttribute("fragno.db.transaction.idempotency_key", context.idempotencyKey);
      }
      if (context.fragmentName) {
        span.setAttribute("fragno.db.fragment.name", context.fragmentName);
      }
      if (context.callback) {
        span.setAttribute("fragno.db.transaction.callback", context.callback);
      }
      return execute();
    });

    if (enteredSpan) {
      return result;
    }
  } catch (error) {
    if (enteredSpan) {
      throw error;
    }
  }

  return execute();
};

/** Creates Cloudflare custom spans for named Fragno database transactions and their callbacks. */
export const cloudflareDatabaseTransactionInstrumentation: DatabaseTransactionInstrumentation = {
  run: runCloudflareTransactionSpan,
};
