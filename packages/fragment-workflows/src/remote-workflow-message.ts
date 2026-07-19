import {
  createRemoteWorkflowSuspension,
  isRemoteWorkflowSuspension,
  RemoteWorkflowSuspendedError,
  type RemoteWorkflowStepHost,
  type RemoteWorkflowStepScope,
} from "./remote-workflow";
import type { WorkflowStepIdentity } from "./step-identity";
import type {
  WorkflowDuration,
  WorkflowStepConfig,
  WorkflowStepConsumeTx,
  WorkflowStepEvent,
  WorkflowStepTx,
  WorkflowStepWorkflowOperation,
} from "./workflow";

export const REMOTE_WORKFLOW_MESSAGE_KEY = "__fragnoRemoteWorkflowMessage";

export type RemoteWorkflowMessagePort = {
  postMessage(message: unknown): void;
  addEventListener?(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener?(type: "message", listener: (event: { data: unknown }) => void): void;
  on?(type: "message", listener: (message: unknown) => void): void;
  off?(type: "message", listener: (message: unknown) => void): void;
};

type RemoteWorkflowMessageRequest = {
  [REMOTE_WORKFLOW_MESSAGE_KEY]: true;
  type: "request";
  id: number;
  method:
    | "do"
    | "sleep"
    | "sleepUntil"
    | "waitForEvent"
    | "tx.emit"
    | "tx.previousEmissions"
    | "tx.workflowServiceCalls";
  payload: Record<string, unknown>;
};

type RemoteWorkflowMessageResponse = {
  [REMOTE_WORKFLOW_MESSAGE_KEY]: true;
  type: "response";
  id: number;
  result?: unknown;
  error?: { message: string; name?: string };
};

type RemoteWorkflowMessageCallback = {
  [REMOTE_WORKFLOW_MESSAGE_KEY]: true;
  type: "callback" | "onConsume";
  id: number;
  requestId: number;
  txId: number;
  scope?: WorkflowStepIdentity;
  event?: unknown;
};

type RemoteWorkflowMessage =
  | RemoteWorkflowMessageRequest
  | RemoteWorkflowMessageResponse
  | RemoteWorkflowMessageCallback;

const unsupportedRemoteTxFeature = (feature: string): never => {
  throw new Error(`REMOTE_WORKFLOW_TX_${feature}_UNSUPPORTED`);
};

const isWorkflowSuspensionError = (
  error: unknown,
): error is { reason: ConstructorParameters<typeof RemoteWorkflowSuspendedError>[0] } => {
  if (!error || typeof error !== "object" || !("reason" in error)) {
    return false;
  }

  const details = error as { name?: unknown; message?: unknown };
  return (
    details.name === "RunnerStepSuspended" ||
    details.name === "RemoteWorkflowSuspendedError" ||
    details.message === "WORKFLOW_STEP_SUSPENDED"
  );
};

const returnSuspensionOrThrow = (
  error: unknown,
): never | ReturnType<typeof createRemoteWorkflowSuspension> => {
  if (isRemoteWorkflowSuspension(error)) {
    return error;
  }
  if (isWorkflowSuspensionError(error)) {
    return createRemoteWorkflowSuspension(error.reason);
  }
  throw error;
};

const isRemoteWorkflowMessage = (message: unknown): message is RemoteWorkflowMessage => {
  if (!message || typeof message !== "object") {
    return false;
  }
  return (
    (message as { [REMOTE_WORKFLOW_MESSAGE_KEY]?: unknown })[REMOTE_WORKFLOW_MESSAGE_KEY] === true
  );
};

const addPortMessageListener = (
  port: RemoteWorkflowMessagePort,
  listener: (message: unknown) => void,
): (() => void) => {
  if (port.addEventListener) {
    const eventListener = (event: { data: unknown }) => listener(event.data);
    port.addEventListener("message", eventListener);
    return () => port.removeEventListener?.("message", eventListener);
  }

  if (port.on) {
    port.on("message", listener);
    return () => port.off?.("message", listener);
  }

  throw new Error("REMOTE_WORKFLOW_MESSAGE_PORT_UNSUPPORTED");
};

const toErrorResponse = (error: unknown): RemoteWorkflowMessageResponse["error"] => {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { message: String(error) };
};

export class WorkflowStepMessageTxTarget {
  readonly #tx: WorkflowStepTx | WorkflowStepConsumeTx;

  constructor(tx: WorkflowStepTx | WorkflowStepConsumeTx) {
    this.#tx = tx;
  }

  emit(payload: unknown): void {
    this.#tx.emit(payload);
  }

  async previousEmissions() {
    return await this.#tx.previousEmissions();
  }

  workflowServiceCalls(operations: readonly WorkflowStepWorkflowOperation[]): void {
    const workflowServiceCalls = (this.#tx as Partial<WorkflowStepTx>).workflowServiceCalls;
    if (!workflowServiceCalls) {
      return unsupportedRemoteTxFeature("WORKFLOW_SERVICE_CALLS");
    }
    workflowServiceCalls(() => operations);
  }

  onEvent(type: string, handler: (event: WorkflowStepEvent) => void | Promise<void>) {
    const onEvent = (this.#tx as Partial<WorkflowStepTx>).onEvent;
    if (!onEvent) {
      return unsupportedRemoteTxFeature("ON_EVENT");
    }
    return onEvent(type, handler);
  }

  mutate(): never {
    return unsupportedRemoteTxFeature("MUTATE");
  }

  serviceCalls(): never {
    return unsupportedRemoteTxFeature("SERVICE_CALLS");
  }

  onTerminalErrorMutate(): never {
    return unsupportedRemoteTxFeature("ON_TERMINAL_ERROR_MUTATE");
  }
}

export class WorkflowStepMessageTarget {
  readonly #host: RemoteWorkflowStepHost;
  readonly #port: RemoteWorkflowMessagePort;
  readonly #callbackResults = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  readonly #txs = new Map<number, WorkflowStepMessageTxTarget>();
  #nextId = 1;
  #disposeListener: (() => void) | undefined;

  constructor(host: RemoteWorkflowStepHost, port: RemoteWorkflowMessagePort) {
    this.#host = host;
    this.#port = port;
  }

  attach(): () => void {
    this.#disposeListener = addPortMessageListener(this.#port, (message) => {
      void this.#handleMessage(message);
    });
    return () => this.dispose();
  }

  dispose(): void {
    this.#disposeListener?.();
    this.#disposeListener = undefined;
    for (const { reject } of this.#callbackResults.values()) {
      reject(new Error("REMOTE_WORKFLOW_MESSAGE_TARGET_DISPOSED"));
    }
    this.#callbackResults.clear();
    this.#txs.clear();
  }

  async #handleMessage(message: unknown): Promise<void> {
    if (!isRemoteWorkflowMessage(message)) {
      return;
    }

    if (message.type === "response") {
      const pending = this.#callbackResults.get(message.id);
      if (!pending) {
        return;
      }
      this.#callbackResults.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.type !== "request") {
      return;
    }

    try {
      const result = await this.#handleRequest(message);
      this.#post({
        [REMOTE_WORKFLOW_MESSAGE_KEY]: true,
        type: "response",
        id: message.id,
        result,
      });
    } catch (error) {
      this.#post({
        [REMOTE_WORKFLOW_MESSAGE_KEY]: true,
        type: "response",
        id: message.id,
        error: toErrorResponse(error),
      });
    }
  }

  async #handleRequest(message: RemoteWorkflowMessageRequest): Promise<unknown> {
    switch (message.method) {
      case "do":
        return await this.do(
          message.payload["parentScope"] as RemoteWorkflowStepScope,
          String(message.payload["name"]),
          message.payload["config"] as WorkflowStepConfig | undefined,
          message.id,
        );
      case "sleep":
        return await this.sleep(
          message.payload["parentScope"] as RemoteWorkflowStepScope,
          String(message.payload["name"]),
          message.payload["duration"] as WorkflowDuration,
        );
      case "sleepUntil":
        return await this.sleepUntil(
          message.payload["parentScope"] as RemoteWorkflowStepScope,
          String(message.payload["name"]),
          message.payload["timestamp"] as Date | number,
        );
      case "waitForEvent":
        return await this.waitForEvent(
          message.payload["parentScope"] as RemoteWorkflowStepScope,
          String(message.payload["name"]),
          {
            type: String(message.payload["eventType"]),
            timeout: message.payload["timeout"] as WorkflowDuration | undefined,
            hasOnConsume: message.payload["hasOnConsume"] === true,
          },
          message.id,
        );
      case "tx.emit": {
        const tx = this.#getTx(message.payload["txId"]);
        tx.emit(message.payload["payload"]);
        return undefined;
      }
      case "tx.previousEmissions": {
        const tx = this.#getTx(message.payload["txId"]);
        return await tx.previousEmissions();
      }
      case "tx.workflowServiceCalls": {
        const tx = this.#getTx(message.payload["txId"]);
        tx.workflowServiceCalls(
          message.payload["operations"] as readonly WorkflowStepWorkflowOperation[],
        );
        return undefined;
      }
    }

    throw new Error("Unsupported remote workflow request method.");
  }

  async do<T>(
    parentScope: RemoteWorkflowStepScope,
    name: string,
    config: WorkflowStepConfig | undefined,
    requestId: number,
  ): Promise<T | ReturnType<typeof createRemoteWorkflowSuspension>> {
    try {
      return await this.#host.do(parentScope, name, config, async (tx, scope) => {
        const result = await this.#invokeRemoteCallback("callback", requestId, tx, { scope });
        if (isRemoteWorkflowSuspension(result)) {
          throw new RemoteWorkflowSuspendedError(result.reason);
        }
        return result as T;
      });
    } catch (error) {
      return returnSuspensionOrThrow(error);
    }
  }

  async sleep(
    parentScope: RemoteWorkflowStepScope,
    name: string,
    duration: WorkflowDuration,
  ): Promise<void | ReturnType<typeof createRemoteWorkflowSuspension>> {
    try {
      await this.#host.sleep(parentScope, name, duration);
    } catch (error) {
      return returnSuspensionOrThrow(error);
    }
  }

  async sleepUntil(
    parentScope: RemoteWorkflowStepScope,
    name: string,
    timestamp: Date | number,
  ): Promise<void | ReturnType<typeof createRemoteWorkflowSuspension>> {
    try {
      await this.#host.sleepUntil(parentScope, name, timestamp);
    } catch (error) {
      return returnSuspensionOrThrow(error);
    }
  }

  async waitForEvent<T = unknown>(
    parentScope: RemoteWorkflowStepScope,
    name: string,
    options: { type: string; timeout?: WorkflowDuration; hasOnConsume?: boolean },
    requestId: number,
  ): Promise<
    | { type: string; payload: Readonly<T>; timestamp: Date }
    | ReturnType<typeof createRemoteWorkflowSuspension>
  > {
    try {
      return await this.#host.waitForEvent<T>(parentScope, name, {
        type: options.type,
        timeout: options.timeout,
        onConsume: options.hasOnConsume
          ? async (tx, event) => {
              await this.#invokeRemoteCallback("onConsume", requestId, tx, { event });
            }
          : undefined,
      });
    } catch (error) {
      return returnSuspensionOrThrow(error);
    }
  }

  async #invokeRemoteCallback(
    type: "callback" | "onConsume",
    requestId: number,
    tx: WorkflowStepTx | WorkflowStepConsumeTx,
    payload: { scope?: WorkflowStepIdentity; event?: unknown },
  ): Promise<unknown> {
    const id = this.#nextId++;
    const txId = this.#nextId++;
    this.#txs.set(txId, new WorkflowStepMessageTxTarget(tx));
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        this.#callbackResults.set(id, { resolve, reject });
        this.#post({
          [REMOTE_WORKFLOW_MESSAGE_KEY]: true,
          type,
          id,
          requestId,
          txId,
          ...payload,
        });
      });
      return result;
    } finally {
      this.#txs.delete(txId);
    }
  }

  #getTx(txId: unknown): WorkflowStepMessageTxTarget {
    if (typeof txId !== "number") {
      throw new Error("REMOTE_WORKFLOW_TX_ID_INVALID");
    }
    const tx = this.#txs.get(txId);
    if (!tx) {
      throw new Error("REMOTE_WORKFLOW_TX_NOT_FOUND");
    }
    return tx;
  }

  #post(message: RemoteWorkflowMessage): void {
    this.#port.postMessage(message);
  }
}

export const createWorkflowStepMessageTarget = (
  host: RemoteWorkflowStepHost,
  port: RemoteWorkflowMessagePort,
): WorkflowStepMessageTarget => new WorkflowStepMessageTarget(host, port);
