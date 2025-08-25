/**
 * @module
 * Stream utility.
 */

export class StreamingApi {
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #encoder: TextEncoder;
  #writable: WritableStream;
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
    this.#writable = writable;
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

  async write(input: Uint8Array | string): Promise<StreamingApi> {
    try {
      if (typeof input === "string") {
        input = this.#encoder.encode(input);
      }
      await this.#writer.write(input);
    } catch {
      // Do nothing. If you want to handle errors, create a stream by yourself.
    }
    return this;
  }

  async writeln(input: string): Promise<StreamingApi> {
    await this.write(input + "\n");
    return this;
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

  async pipe(body: ReadableStream) {
    this.#writer.releaseLock();
    await body.pipeTo(this.#writable, { preventClose: true });
    this.#writer = this.#writable.getWriter();
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
