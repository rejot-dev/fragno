import type { DatabaseAdapter } from "../adapters/adapters";
import type { OutboxStreamOptions, SerializedOutboxStreamEntry } from "../outbox/outbox-stream";

/** Streams one bounded page without interpreting or reconstructing stored outbox payload JSON. */
export function streamOutboxEntries(
  adapter: DatabaseAdapter<unknown>,
  options: OutboxStreamOptions,
): AsyncIterableIterator<SerializedOutboxStreamEntry> {
  return adapter.streamSerializedOutboxEntries(options);
}
