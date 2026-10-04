import type { MessagePort } from "node:worker_threads";

import {
  RpcSession,
  type RpcCompatible,
  type RpcStub,
  type RpcTransportWithCustomEncoding,
} from "capnweb";

class NodeMessagePortTransport implements RpcTransportWithCustomEncoding {
  readonly encodingLevel = "structuredClonable" as const;
  readonly #port: MessagePort;
  readonly #assertAuthority: (() => void) | null;
  readonly #messages: unknown[] = [];
  #receiver: {
    resolve(message: unknown): void;
    reject(error: Error): void;
  } | null = null;
  #failure: Error | null = null;

  constructor(port: MessagePort, assertAuthority: (() => void) | null) {
    this.#port = port;
    this.#assertAuthority = assertAuthority;
    port.on("message", (message: unknown) => {
      if (this.#failure) {
        return;
      }
      if (this.#receiver) {
        const receiver = this.#receiver;
        this.#receiver = null;
        receiver.resolve(message);
      } else {
        this.#messages.push(message);
      }
    });
    port.once("messageerror", (error: Error) => {
      this.abort(error);
    });
    // Cap'n Web's browser MessagePort transport does not observe Node's close event. Without
    // this adapter, a crashed worker leaves outstanding RPC calls waiting forever.
    port.once("close", () => {
      this.abort(new Error("NODE_MESSAGE_PORT_RPC_CLOSED"));
    });
  }

  send(message: unknown): void {
    if (this.#failure) {
      throw this.#failure;
    }
    try {
      this.#assertAuthority?.();
      this.#port.postMessage(message);
    } catch (error) {
      this.abort(error);
      throw error;
    }
  }

  async receive(): Promise<unknown> {
    if (this.#failure) {
      throw this.#failure;
    }
    const message =
      this.#messages.length > 0
        ? this.#messages.shift()
        : await new Promise<unknown>((resolve, reject) => {
            this.#receiver = { resolve, reject };
          });
    try {
      // A reply queued before suspension must not acknowledge authority after the main thread resumes.
      this.#assertAuthority?.();
      return message;
    } catch (error) {
      this.abort(error);
      throw error;
    }
  }

  abort(reason: unknown): void {
    if (this.#failure) {
      return;
    }
    this.#failure =
      reason instanceof Error
        ? reason
        : new Error("NODE_MESSAGE_PORT_RPC_ABORTED", { cause: reason });
    this.#messages.length = 0;
    this.#receiver?.reject(this.#failure);
    this.#receiver = null;
    this.#port.close();
  }
}

/** Creates a Node MessagePort RPC session; callers must finish their RPC work before aborting it. */
export function createNodeMessagePortRpcSession<T extends RpcCompatible<T>>(
  port: MessagePort,
  localMain: unknown,
  assertAuthority: (() => void) | null,
): { remote: RpcStub<T>; abort(reason: unknown): void } {
  const transport = new NodeMessagePortTransport(port, assertAuthority);
  const session = new RpcSession<T>(transport, localMain);
  return {
    remote: session.getRemoteMain(),
    abort(reason) {
      transport.abort(reason);
    },
  };
}
