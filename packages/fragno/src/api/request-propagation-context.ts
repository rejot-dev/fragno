export type RequestPropagationContext = Readonly<Record<string, string>>;

/** Extracts the W3C trace carrier accepted by Fragno request lifecycles. */
export function extractW3CRequestPropagationContext(
  headers: Headers,
): RequestPropagationContext | null {
  const traceparent = headers.get("traceparent");
  if (!traceparent) {
    return null;
  }

  const tracestate = headers.get("tracestate");
  return tracestate ? { traceparent, tracestate } : { traceparent };
}
