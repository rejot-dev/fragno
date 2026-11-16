import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    "then" in value
  );
}

function recordNodeOpenTelemetryError(span: Span, error: unknown): void {
  span.recordException(error instanceof Error ? error : String(error));
  span.setStatus({
    code: SpanStatusCode.ERROR,
    ...(error instanceof Error ? { message: error.message } : {}),
  });
}

/** Runs synchronous or asynchronous Node work inside one active OpenTelemetry span. */
export function runNodeOpenTelemetrySpan<T>(name: string, execute: (span: Span) => T): T {
  // Looked up per span: a tracer kept from before the global provider was replaced records nowhere.
  return trace.getTracer("rejot-backoffice").startActiveSpan(name, (span) => {
    try {
      const result = execute(span);
      if (isPromiseLike(result)) {
        return Promise.resolve(result).then(
          (value) => {
            span.end();
            return value;
          },
          (error: unknown) => {
            recordNodeOpenTelemetryError(span, error);
            span.end();
            throw error;
          },
        ) as T;
      }

      span.end();
      return result;
    } catch (error) {
      recordNodeOpenTelemetryError(span, error);
      span.end();
      throw error;
    }
  });
}
