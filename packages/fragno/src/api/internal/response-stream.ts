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

export class ResponseStream<TItem> {
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #encoder: TextEncoder;
  #abortSubscribers: (() => void | Promise<void>)[] = [];
  #responseReadable: ReadableStream;

  #aborted: boolean = false;
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
   * The readable stream that the response is piped to.
   */
  get responseReadable(): ReadableStream {
    return this.#responseReadable;
  }

  constructor(writable: WritableStream, readable: ReadableStream) {
    this.#writer = writable.getWriter();
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
      cancel: () => {
        this.abort();
      },
    });
  }

  async writeRaw(input: Uint8Array | string): Promise<void> {
    try {
      if (typeof input === "string") {
        input = this.#encoder.encode(input);
      }
      await this.#writer.write(input);
    } catch {
      // Do nothing.
    }
  }

  write(input: TItem): Promise<void> {
    if (input instanceof Uint8Array) {
      throw new Error("Uint8Array is not supported for JSON streams");
    }

    return this.writeRaw(JSON.stringify(input) + "\n");
  }

  sleep(ms: number): Promise<unknown> {
    return new Promise((res) => setTimeout(res, ms));
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
  abort() {
    if (!this.aborted) {
      this.#aborted = true;
      this.#abortSubscribers.forEach((subscriber) => subscriber());
    }
  }
}
