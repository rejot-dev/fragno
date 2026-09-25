/** Only transport interruptions permit retrying an outbox stream session. */
export class FragnoOutboxTransportError extends Error {}

/** Classify network errors only at Fetch/read boundaries, never around decoding or application. */
export function rethrowOutboxNetworkFailure(
  cause: unknown,
  signal: AbortSignal | undefined,
): never {
  // Fetch reports network failures as TypeError (or NetworkError in some stream implementations).
  // Construct and validate requests outside this boundary so request errors remain terminal.
  if (
    !signal?.aborted &&
    (cause instanceof TypeError || (cause instanceof DOMException && cause.name === "NetworkError"))
  ) {
    throw new FragnoOutboxTransportError("Fragno outbox stream transport interrupted.", { cause });
  }
  throw cause;
}
