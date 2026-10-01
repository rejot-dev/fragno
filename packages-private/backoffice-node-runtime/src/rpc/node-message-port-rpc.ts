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
  readonly #messages: unknown[] = [];
  #receiver: {
    resolve(message: unknown): void;
    reject(error: Error): void;
  } | null = null;
  #failure: Error | null = null;

  constructor(port: MessagePort) {
    this.#port = port;
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
    if (this.#messages.length > 0) {
      return this.#messages.shift();
    }
    return await new Promise<unknown>((resolve, reject) => {
      this.#receiver = { resolve, reject };
    });
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
): { remote: RpcStub<T>; abort(reason: unknown): void } {
  const transport = new NodeMessagePortTransport(port);
  const session = new RpcSession<T>(transport, localMain);
  return {
    remote: session.getRemoteMain(),
    abort(reason) {
      transport.abort(reason);
    },
  };
}
