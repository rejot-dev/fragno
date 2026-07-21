import { type DurableStream, type JsonBatch } from "@durable-streams/client";

export type StreamConsumerMode = false | "long-poll";

export type ConsumeDurableStreamOptions = {
  offset: string;
  mode: StreamConsumerMode;
  signal: AbortSignal;
  processBatch: (batch: JsonBatch<unknown>) => Promise<void>;
};

const toError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(typeof value === "string" ? value : String(value));

/** Transport-only Durable Streams consumer. It has no schema, TanStack, or persistence knowledge. */
export class DurableStreamConsumer {
  readonly #stream: DurableStream;

  constructor(stream: DurableStream) {
    this.#stream = stream;
  }

  async consume(options: ConsumeDurableStreamOptions): Promise<void> {
    const response = await this.#stream.stream<unknown>({
      offset: options.offset,
      live: options.mode,
      json: true,
      signal: options.signal,
    });

    let reachedUpToDate = false;
    let resolveUpToDate!: () => void;
    let rejectUpToDate!: (error: Error) => void;
    const upToDate = new Promise<void>((resolve, reject) => {
      resolveUpToDate = resolve;
      rejectUpToDate = reject;
    });
    if (options.mode !== false) {
      void upToDate.catch(() => undefined);
    }

    const unsubscribe = response.subscribeJson(async (batch) => {
      try {
        await options.processBatch(batch);
        if (batch.upToDate) {
          reachedUpToDate = true;
          resolveUpToDate();
        }
      } catch (error) {
        const processingError = toError(error);
        rejectUpToDate(processingError);
        throw processingError;
      }
    });

    if (options.mode === false) {
      void response.closed.then(
        () => {
          if (!reachedUpToDate && !response.upToDate) {
            rejectUpToDate(
              new Error(
                "Durable Streams response closed before reaching an up-to-date checkpoint.",
              ),
            );
          }
        },
        (error) => rejectUpToDate(toError(error)),
      );
      try {
        await upToDate;
      } finally {
        unsubscribe();
      }
      return;
    }

    await response.closed;
  }
}
