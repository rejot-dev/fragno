import {
  resolveRemoteWorkflowHookIntent,
  type RemoteWorkflowAllowedHook,
  type RemoteWorkflowHookIntent,
  type RemoteWorkflowStepHost,
} from "@fragno-dev/workflows/remote-workflow";
import {
  NonRetryableError,
  type WorkflowDuration,
  type WorkflowStepConfig,
  type WorkflowStepConsumeTx,
  type WorkflowStepEvent,
  type WorkflowStepTx,
  type WorkflowStepWorkflowOperation,
} from "@fragno-dev/workflows/workflow";
import { parseBackofficeUiResult } from "@fragno-private/backoffice-ui/result";

const unsupportedRemoteTxFeature = (feature: string): never => {
  throw new Error(`REMOTE_WORKFLOW_TX_${feature}_UNSUPPORTED`);
};

class BackofficeWorkflowTransactionHost {
  readonly #tx: WorkflowStepTx | WorkflowStepConsumeTx;
  readonly #allowedHooks: readonly RemoteWorkflowAllowedHook[];

  constructor(
    tx: WorkflowStepTx | WorkflowStepConsumeTx,
    allowedHooks: readonly RemoteWorkflowAllowedHook[],
  ) {
    this.#tx = tx;
    this.#allowedHooks = allowedHooks;
  }

  emit(payload: unknown): void {
    this.#tx.emit(payload);
  }

  async previousEmissions() {
    return await this.#tx.previousEmissions();
  }

  async previousConsumedEvents() {
    const previousConsumedEvents = (this.#tx as Partial<WorkflowStepTx>).previousConsumedEvents;
    if (!previousConsumedEvents) {
      return unsupportedRemoteTxFeature("PREVIOUS_CONSUMED_EVENTS");
    }
    return await previousConsumedEvents();
  }

  workflowServiceCalls(operations: readonly WorkflowStepWorkflowOperation[]): void {
    const workflowServiceCalls = (this.#tx as Partial<WorkflowStepTx>).workflowServiceCalls;
    if (!workflowServiceCalls) {
      return unsupportedRemoteTxFeature("WORKFLOW_SERVICE_CALLS");
    }
    workflowServiceCalls(() => operations);
  }

  triggerHook(operation: RemoteWorkflowHookIntent): void {
    const resolved = resolveRemoteWorkflowHookIntent(operation, this.#allowedHooks);
    const triggerHook = (this.#tx as Partial<WorkflowStepTx>).triggerHook;
    if (!triggerHook) {
      return unsupportedRemoteTxFeature("TRIGGER_HOOK");
    }
    triggerHook(resolved);
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

/** Trusted workflow adapter; revocable RPC capabilities wrap it before anything reaches the guest. */
export class BackofficeWorkflowStepHost {
  readonly #host: RemoteWorkflowStepHost;
  readonly #allowedHooks: readonly RemoteWorkflowAllowedHook[];

  constructor(host: RemoteWorkflowStepHost, allowedHooks: readonly RemoteWorkflowAllowedHook[]) {
    this.#host = host;
    this.#allowedHooks = allowedHooks;
  }

  async do<T>(
    name: string,
    config: WorkflowStepConfig | undefined,
    callback: (tx: BackofficeWorkflowTransactionHost) => Promise<T> | T,
  ) {
    return await this.#host.do(name, config, async (tx) => {
      const result = await callback(new BackofficeWorkflowTransactionHost(tx, this.#allowedHooks));
      // An invalid interface can never collect the input a later waitForEvent awaits, and the same
      // deterministic callback would rebuild it on retry.
      const generatedUi = parseBackofficeUiResult(result);
      if (generatedUi.kind === "invalid") {
        throw new NonRetryableError(
          `Step "${name}" returned an invalid generated UI: ${generatedUi.message}`,
        );
      }
      return result;
    });
  }

  async sleep(name: string, duration: WorkflowDuration) {
    return await this.#host.sleep(name, duration);
  }

  async sleepUntil(name: string, timestamp: Date | number) {
    return await this.#host.sleepUntil(name, timestamp);
  }

  async waitForEvent<T = unknown>(
    name: string,
    options: {
      type: string;
      timeout?: WorkflowDuration;
      onConsume?: (
        tx: BackofficeWorkflowTransactionHost,
        event: { type: string; payload: Readonly<T>; timestamp: Date },
      ) => Promise<void> | void;
    },
  ) {
    return await this.#host.waitForEvent<T>(name, {
      type: options.type,
      timeout: options.timeout,
      onConsume: options.onConsume
        ? async (tx, event) => {
            await options.onConsume?.(
              new BackofficeWorkflowTransactionHost(tx, this.#allowedHooks),
              event,
            );
          }
        : undefined,
    });
  }
}
