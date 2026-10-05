import type { RpcSessionOptions, RpcTransport } from "capnweb";

import { CODEMODE_LIMITS } from "../codemode-limits";
import { CodemodeInterruptedError } from "../execution/codemode-errors";

function redactCodemodeRpcError(error: Error): Error {
  const sanitized = new Error(error.message.slice(0, 32_768));
  sanitized.name = error.name.slice(0, 1024);
  // Cap'n Web otherwise exports causes and enumerable properties, including internal credentials.
  // Returning a rewritten Error opts into stack transmission, so omit that explicitly too.
  delete sanitized.stack;
  return sanitized;
}

/** Both peers bound decoding and keep RPC error causes, stacks, and arbitrary properties local. */
export const CODEMODE_RPC_OPTIONS = {
  onSendError: redactCodemodeRpcError,
  limits: {
    maxMessageSize: CODEMODE_LIMITS.maxFrameBytes,
    maxDepth: CODEMODE_LIMITS.maxDepth,
    maxBigIntDigits: 4096,
  },
} satisfies RpcSessionOptions;

type CodemodeSocket = {
  send(text: string): void;
  close(code: number, reason: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", listener: () => void): void;
};

/** Bounded WebSocket framing only; Cap'n Web owns serialization, references, and call correlation. */
export class CodemodeWebSocketTransport implements RpcTransport {
  readonly #socket: CodemodeSocket;
  readonly #bufferedBytes: () => number;
  readonly #onClose: (error: Error) => void;
  readonly #referenceCount: () => number;
  readonly #queue: { text: string; bytes: number }[] = [];
  #waiter: { resolve(text: string): void; reject(error: Error): void } | null = null;
  #error: Error | null = null;
  #queuedBytes = 0;
  #messages = 0;
  #bytes = 0;
  constructor(
    socket: CodemodeSocket,
    bufferedBytes: () => number,
    onClose: (error: Error) => void,
    referenceCount: () => number,
  ) {
    this.#socket = socket;
    this.#bufferedBytes = bufferedBytes;
    this.#onClose = onClose;
    this.#referenceCount = referenceCount;
    socket.addEventListener("message", (event) => {
      if (this.#error) {
        return;
      }
      try {
        if (typeof event.data !== "string") {
          throw new Error("CODEMODE_TEXT_FRAME_REQUIRED");
        }
        const bytes = this.#budget(event.data);
        if (this.#waiter) {
          this.#waiter.resolve(event.data);
          this.#waiter = null;
        } else {
          if (this.#queuedBytes + bytes > CODEMODE_LIMITS.maxQueuedBytes) {
            throw new Error("CODEMODE_READ_QUEUE_LIMIT_EXCEEDED");
          }
          this.#queuedBytes += bytes;
          this.#queue.push({ text: event.data, bytes });
        }
      } catch (error) {
        this.abort(error);
      }
    });
    socket.addEventListener("close", () => {
      this.abort(new CodemodeInterruptedError("CODEMODE_EXECUTION_INTERRUPTED"));
    });
    socket.addEventListener("error", () => {
      this.abort(new CodemodeInterruptedError("CODEMODE_CONNECTION_FAILED"));
    });
  }
  get metrics() {
    return { messages: this.#messages, bytes: this.#bytes };
  }
  get closed() {
    return this.#error !== null;
  }
  #budget(text: string) {
    this.#checkReferences();
    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > CODEMODE_LIMITS.maxFrameBytes) {
      throw new Error("CODEMODE_FRAME_LIMIT_EXCEEDED");
    }
    this.#messages += 1;
    this.#bytes += bytes;
    if (
      this.#messages > CODEMODE_LIMITS.maxMessages ||
      this.#bytes > CODEMODE_LIMITS.maxSessionBytes
    ) {
      throw new Error("CODEMODE_SESSION_LIMIT_EXCEEDED");
    }
    return bytes;
  }
  send(text: string): void {
    if (this.#error) {
      throw this.#error;
    }
    const bytes = this.#budget(text);
    if (this.#bufferedBytes() + bytes > CODEMODE_LIMITS.maxQueuedBytes) {
      throw new Error("CODEMODE_WRITE_QUEUE_LIMIT_EXCEEDED");
    }
    this.#socket.send(text);
  }
  #checkReferences() {
    if (this.#referenceCount() > CODEMODE_LIMITS.maxRpcReferences) {
      throw new Error("CODEMODE_RPC_REFERENCE_LIMIT_EXCEEDED");
    }
  }
  async receive(): Promise<string> {
    if (this.#error) {
      throw this.#error;
    }
    this.#checkReferences();
    const message = this.#queue.shift();
    if (message) {
      this.#queuedBytes -= message.bytes;
      return Promise.resolve(message.text);
    }
    return new Promise<string>((resolve, reject) => {
      this.#waiter = { resolve, reject };
    });
  }
  abort(reason: unknown): void {
    if (this.#error) {
      return;
    }
    this.#error = reason instanceof Error ? reason : new Error(String(reason));
    this.#queue.length = 0;
    this.#queuedBytes = 0;
    this.#waiter?.reject(this.#error);
    this.#waiter = null;
    this.#onClose(this.#error);
    try {
      this.#socket.close(1000, "Codemode activation ended");
    } catch {
      /* The peer may already have closed. */
    }
  }
}
