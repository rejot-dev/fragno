/**
 * @module
 * Stream utility.
 *
 * Modified from honojs/hono
 * Original source: https://github.com/honojs/hono/blob/0e3db674ad3f40be215a55a18062dd8e387ce525/src/utils/stream.ts
 * License: MIT
 * Date obtained: August 28 2025
 * Copyright (c) 2021-present Yusuke Wada and Hono contributors
 */

type Error<Message extends string> = { __errorMessage: Message };

export class ResponseStream<TArray> {
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #encoder: TextEncoder;
  readonly #abortSubscribers: (() => void | Promise<void>)[] = [];
  readonly #responseReadable: ReadableStream;

  #aborted: boolean = false;
  #abortPromise: Promise<void> | undefined;
  #closed: boolean = false;

  /**
   * Whether the stream has been aborted.
   */
  get aborted(): boolean {
    return this.#aborted;
  }

  /**
   * Whether the stream has been closed normally.
   */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Bytes the response can still hold before writes wait for the client to read: zero or less when
   * its buffer is full, and `null` once the stream errored. A full buffer means the client, or the
   * network on its way, is slower than the writer.
   */
  get desiredSize(): number | null {
    return this.#bufferDesiredSize();
  }

  /**
   * The readable stream that the response is piped to.
   */
  get responseReadable(): ReadableStream {
    return this.#responseReadable;
  }

  readonly #bufferDesiredSize: () => number | null;

  /**
   * @param bufferDesiredSize Reports the room left in the buffer between `writable` and
   *   `readable`; without it, the writer's own `desiredSize` stands in.
   */
  constructor(
    writable: WritableStream,
    readable: ReadableStream,
    bufferDesiredSize?: () => number | null,
  ) {
    this.#writer = writable.getWriter();
    this.#bufferDesiredSize = bufferDesiredSize ?? (() => this.#writer.desiredSize);
    this.#encoder = new TextEncoder();
    const reader = readable.getReader();

    // in case the user disconnects, let the reader know to cancel
    // this in-turn results in responseReadable being closed
    // and writeSSE method no longer blocks indefinitely
    this.#abortSubscribers.push(async () => {
      await reader.cancel();
    });

    this.#responseReadable = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      },
      cancel: () => this.abort(),
    });
  }

  async writeRaw(input: Uint8Array | string): Promise<boolean> {
    try {
      if (typeof input === "string") {
        input = this.#encoder.encode(input);
      }
      await this.#writer.write(input);
      return true;
    } catch {
      return false;
    }
  }

  async write(
    input: TArray extends (infer U)[]
      ? U
      : Error<"To use a streaming response, outputSchema must be an array.">,
  ): Promise<void> {
    await this.writeRaw(JSON.stringify(input) + "\n");
  }

  sleep(ms: number): Promise<unknown> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  async close() {
    try {
      await this.#writer.close();
    } catch {
      // Do nothing. If you want to handle errors, create a stream by yourself.
    } finally {
      this.#closed = true;
    }
  }

  onAbort(listener: () => void | Promise<void>) {
    this.#abortSubscribers.push(listener);
  }

  /**
   * Abort the stream.
   * You can call this method when stream is aborted by external event.
   */
  abort(): Promise<void> {
    if (!this.#abortPromise) {
      this.#aborted = true;
      this.#abortPromise = Promise.allSettled(
        this.#abortSubscribers.map(async (subscriber) => subscriber()),
      ).then((results) => {
        const errors: unknown[] = [];
        for (const result of results) {
          if (result.status === "rejected") {
            errors.push(result.reason);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, "Failed to abort response stream.");
        }
      });
    }

    return this.#abortPromise;
  }
}
