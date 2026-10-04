import { RemoteWorkflowSuspendedError } from "@fragno-dev/workflows/remote-workflow";

import { CODEMODE_LIMITS } from "../codemode-limits";
import {
  CodemodeInterruptedError,
  decodeCodemodeError,
  encodeCodemodeError,
} from "./codemode-errors";
import {
  codemodeGuestOperationSchema,
  codemodeHostOperationSchema,
  codemodeMessageSchema,
  codemodeSuspensionReasonSchema,
  type CodemodeMessage,
  type CodemodeHostOperation,
  type CodemodeGuestOperation,
} from "./codemode-protocol";
import { decodeCodemodeFrame, encodeCodemodeFrame } from "./codemode-values";

type Operation = CodemodeHostOperation | CodemodeGuestOperation;
type Control = Exclude<CodemodeMessage, { type: "call" | "return" }>;
type PendingCall = {
  operation: Operation;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

type CodemodePeerOptions = {
  role: "node" | "bridge";
  send(text: string): void;
  bufferedBytes(): number;
  close(): void;
  handle(call: Operation): Promise<unknown>;
  control(message: Control): void;
  onClose(error: Error): void;
};

/** Reentrant connection-local correlation; close revokes all pending calls exactly once. */
export class CodemodePeer {
  readonly #options: CodemodePeerOptions;
  readonly #pending = new Map<number, PendingCall>();
  readonly #active = new Set<Promise<void>>();
  #state: "awaiting-start" | "running" | "closed" = "awaiting-start";
  #nextCall = 0;
  #lastReceivedCall = 0;
  #messageCount = 0;
  #byteCount = 0;

  constructor(options: CodemodePeerOptions) {
    this.#options = options;
  }

  get closed(): boolean {
    return this.#state === "closed";
  }

  get metrics() {
    return {
      messages: this.#messageCount,
      bytes: this.#byteCount,
      callsSent: this.#nextCall,
      callsReceived: this.#lastReceivedCall,
    };
  }

  #budget(text: string) {
    this.#messageCount += 1;
    this.#byteCount += new TextEncoder().encode(text).byteLength;
    if (
      this.#messageCount > CODEMODE_LIMITS.maxMessages ||
      this.#byteCount > CODEMODE_LIMITS.maxSessionBytes
    ) {
      throw new Error("CODEMODE_SESSION_LIMIT_EXCEEDED");
    }
  }

  send(message: CodemodeMessage): void {
    if (this.closed) {
      throw new CodemodeInterruptedError("CODEMODE_CONNECTION_CLOSED");
    }
    if (message.type === "start") {
      if (this.#options.role !== "node" || this.#state !== "awaiting-start") {
        throw new Error("CODEMODE_INVALID_START");
      }
      this.#state = "running";
    }
    const text = encodeCodemodeFrame(message);
    this.#budget(text);
    if (
      this.#options.bufferedBytes() + new TextEncoder().encode(text).byteLength >
      CODEMODE_LIMITS.maxQueuedBytes
    ) {
      throw new Error("CODEMODE_WRITE_QUEUE_LIMIT_EXCEEDED");
    }
    this.#options.send(text);
  }

  async call(operation: Operation): Promise<unknown> {
    if (this.#state !== "running") {
      throw new CodemodeInterruptedError("CODEMODE_CONNECTION_NOT_RUNNING");
    }
    const outgoing =
      this.#options.role === "node" ? codemodeGuestOperationSchema : codemodeHostOperationSchema;
    outgoing.parse(operation);
    if (this.#pending.size >= CODEMODE_LIMITS.maxCalls) {
      const error = new Error("CODEMODE_PENDING_CALL_LIMIT_EXCEEDED");
      this.close(error);
      throw error;
    }
    const id = ++this.#nextCall;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close(new CodemodeInterruptedError("CODEMODE_CALL_TIMED_OUT"));
      }, CODEMODE_LIMITS.callTimeoutMs);
      this.#pending.set(id, { operation, resolve, reject, timer });
      try {
        this.send({ type: "call", id, call: operation });
      } catch (error) {
        this.close(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  receive(data: unknown): void {
    if (this.closed) {
      return;
    }
    try {
      if (typeof data !== "string") {
        throw new Error("CODEMODE_TEXT_FRAME_REQUIRED");
      }
      this.#budget(data);
      const message = codemodeMessageSchema.parse(decodeCodemodeFrame(data));
      if (message.type === "start") {
        if (this.#options.role !== "bridge" || this.#state !== "awaiting-start") {
          throw new Error("CODEMODE_INVALID_START");
        }
        this.#state = "running";
        this.#options.control(message);
        return;
      }
      if (message.type === "cancel") {
        if (this.#options.role !== "bridge") {
          throw new Error("CODEMODE_WRONG_MESSAGE_ROLE");
        }
        this.#options.control(message);
        return;
      }
      if (this.#state !== "running") {
        throw new Error("CODEMODE_START_REQUIRED");
      }
      if (message.type === "complete") {
        if (this.#options.role !== "node") {
          throw new Error("CODEMODE_WRONG_MESSAGE_ROLE");
        }
        this.#options.control(message);
        return;
      }
      if (message.type === "return") {
        const pending = this.#pending.get(message.id);
        if (!pending) {
          throw new Error("CODEMODE_UNKNOWN_RETURN_ID");
        }
        if (
          message.result.status === "suspended" &&
          (this.#options.role !== "bridge" || !pending.operation.operation.startsWith("step."))
        ) {
          throw new Error("CODEMODE_UNEXPECTED_SUSPENSION");
        }
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.result.status === "ok") {
          pending.resolve(message.result.value);
        } else if (message.result.status === "error") {
          pending.reject(decodeCodemodeError(message.result.error));
        } else {
          pending.reject(new RemoteWorkflowSuspendedError(message.result.reason));
        }
        return;
      }
      const incoming =
        this.#options.role === "node" ? codemodeHostOperationSchema : codemodeGuestOperationSchema;
      const operation = incoming.parse(message.call);
      if (message.id !== this.#lastReceivedCall + 1) {
        throw new Error("CODEMODE_INVALID_CALL_ID");
      }
      if (this.#active.size >= CODEMODE_LIMITS.maxCalls) {
        throw new Error("CODEMODE_ACTIVE_CALL_LIMIT_EXCEEDED");
      }
      this.#lastReceivedCall = message.id;
      // Never await here: a host call can itself need a guest callback and further host calls.
      const task = this.#dispatch(message.id, operation);
      this.#active.add(task);
      void task
        .catch((error: unknown) => {
          this.close(error instanceof Error ? error : new Error(String(error)));
        })
        .finally(() => {
          this.#active.delete(task);
        });
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async #dispatch(id: number, operation: Operation): Promise<void> {
    let result: Extract<CodemodeMessage, { type: "return" }>["result"];
    try {
      result = { status: "ok", value: await this.#options.handle(operation) };
    } catch (error) {
      result =
        error instanceof RemoteWorkflowSuspendedError && this.#options.role === "node"
          ? { status: "suspended", reason: codemodeSuspensionReasonSchema.parse(error.reason) }
          : { status: "error", error: encodeCodemodeError(error) };
    }
    if (this.closed) {
      return;
    }
    try {
      this.send({ type: "return", id, result });
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)));
    }
  }

  close(error = new CodemodeInterruptedError("CODEMODE_EXECUTION_INTERRUPTED")): void {
    if (this.closed) {
      return;
    }
    this.#state = "closed";
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    try {
      this.#options.onClose(error);
    } finally {
      this.#options.close();
    }
  }
}
