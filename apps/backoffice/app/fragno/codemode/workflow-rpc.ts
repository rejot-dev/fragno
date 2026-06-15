import {
  createRemoteWorkflowSuspension,
  isRemoteWorkflowSuspension,
  RemoteWorkflowSuspendedError,
  type RemoteWorkflowStepHost,
  type RemoteWorkflowStepScope,
  type WorkflowStepIdentity,
} from "@fragno-dev/workflows/remote-workflow";
import type {
  WorkflowDuration,
  WorkflowStepConfig,
  WorkflowStepConsumeTx,
  WorkflowStepEvent,
  WorkflowStepTx,
  WorkflowStepWorkflowOperation,
} from "@fragno-dev/workflows/workflow";
import { RpcTarget } from "cloudflare:workers";

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

class WorkflowStepTxTarget extends RpcTarget {
  readonly #tx: WorkflowStepTx | WorkflowStepConsumeTx;

  constructor(tx: WorkflowStepTx | WorkflowStepConsumeTx) {
    super();
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

  onEvent(type: string, handler: (event: WorkflowStepEvent<unknown>) => void | Promise<void>) {
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

export class WorkflowStepTarget extends RpcTarget {
  readonly #host: RemoteWorkflowStepHost;

  constructor(host: RemoteWorkflowStepHost) {
    super();
    this.#host = host;
  }

  async do<T>(
    parentScope: RemoteWorkflowStepScope,
    name: string,
    config: WorkflowStepConfig | undefined,
    callback: (tx: WorkflowStepTxTarget, scope: WorkflowStepIdentity) => Promise<T> | T,
  ): Promise<T> {
    try {
      return await this.#host.do(parentScope, name, config, async (tx, scope) => {
        try {
          const result = await callback(new WorkflowStepTxTarget(tx), scope);
          if (isRemoteWorkflowSuspension(result)) {
            throw new RemoteWorkflowSuspendedError(result.reason);
          }
          return result;
        } catch (error) {
          if (isRemoteWorkflowSuspension(error)) {
            throw new RemoteWorkflowSuspendedError(error.reason);
          }
          throw error;
        }
      });
    } catch (error) {
      return returnSuspensionOrThrow(error) as T;
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
    options: {
      type: string;
      timeout?: WorkflowDuration;
      onConsume?: (
        tx: WorkflowStepTxTarget,
        event: { type: string; payload: Readonly<T>; timestamp: Date },
      ) => Promise<void> | void;
    },
  ): Promise<{ type: string; payload: Readonly<T>; timestamp: Date }> {
    try {
      return await this.#host.waitForEvent<T>(parentScope, name, {
        type: options.type,
        timeout: options.timeout,
        onConsume: options.onConsume
          ? async (tx, event) => {
              await options.onConsume?.(new WorkflowStepTxTarget(tx), event);
            }
          : undefined,
      });
    } catch (error) {
      return returnSuspensionOrThrow(error) as unknown as {
        type: string;
        payload: Readonly<T>;
        timestamp: Date;
      };
    }
  }
}
