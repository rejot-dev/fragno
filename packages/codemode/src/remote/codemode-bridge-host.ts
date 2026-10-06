import { RpcTarget } from "capnweb";

import { CODEMODE_LIMITS } from "../codemode-limits";
import type {
  CodemodeCapabilities,
  CodemodeHost,
  CodemodeProviderCapability,
  CodemodeStepCapability,
  CodemodeTransactionCapability,
} from "../execution/codemode-activation-contract";

/** Tracks forwarded host operations without exposing host lifecycle methods or interpreting their results. */
export function createCodemodeBridgeHost(source: CodemodeCapabilities): CodemodeHost {
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  function trackBridgeHostCall<T>(operation: () => Promise<T>): Promise<T> {
    if (closed) {
      throw new Error("CODEMODE_HOST_CLOSED");
    }
    if (pending.size >= CODEMODE_LIMITS.maxCalls) {
      throw new Error("CODEMODE_ACTIVE_CALL_LIMIT_EXCEEDED");
    }
    const task = (async () => await operation())();
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  }
  class BridgeProvider extends RpcTarget implements CodemodeProviderCapability {
    readonly #provider: CodemodeProviderCapability;
    constructor(provider: CodemodeProviderCapability) {
      super();
      this.#provider = provider;
    }
    call(tool: string, args: unknown[]) {
      return trackBridgeHostCall(() => this.#provider.call(tool, args));
    }
  }
  function forwardTransaction(tx: CodemodeTransactionCapability): CodemodeTransactionCapability {
    class BridgeTransaction extends RpcTarget implements CodemodeTransactionCapability {
      emit(payload: unknown) {
        return trackBridgeHostCall(() => tx.emit(payload));
      }
      previousEmissions() {
        return trackBridgeHostCall(() => tx.previousEmissions());
      }
      previousConsumedEvents() {
        return trackBridgeHostCall(() => tx.previousConsumedEvents());
      }
      workflowServiceCalls(
        operations: Parameters<CodemodeTransactionCapability["workflowServiceCalls"]>[0],
      ) {
        return trackBridgeHostCall(() => tx.workflowServiceCalls(operations));
      }
      triggerHook(intent: Parameters<CodemodeTransactionCapability["triggerHook"]>[0]) {
        return trackBridgeHostCall(() => tx.triggerHook(intent));
      }
      onEvent(type: string, callback: Parameters<CodemodeTransactionCapability["onEvent"]>[1]) {
        return trackBridgeHostCall(async () => {
          const unsubscribe = await tx.onEvent(type, callback);
          return async () => {
            await trackBridgeHostCall(unsubscribe);
          };
        });
      }
    }
    return new BridgeTransaction();
  }
  function forwardStep(step: CodemodeStepCapability): CodemodeStepCapability {
    class BridgeStep extends RpcTarget implements CodemodeStepCapability {
      do(...[name, config, callback]: Parameters<CodemodeStepCapability["do"]>) {
        return trackBridgeHostCall(() =>
          step.do(name, config, (tx, nested) =>
            callback(forwardTransaction(tx), forwardStep(nested)),
          ),
        );
      }
      sleep(...args: Parameters<CodemodeStepCapability["sleep"]>) {
        return trackBridgeHostCall(() => step.sleep(...args));
      }
      sleepUntil(...args: Parameters<CodemodeStepCapability["sleepUntil"]>) {
        return trackBridgeHostCall(() => step.sleepUntil(...args));
      }
      waitForEvent(name: string, options: Parameters<CodemodeStepCapability["waitForEvent"]>[1]) {
        const onConsume = options.onConsume;
        return trackBridgeHostCall(() =>
          step.waitForEvent(name, {
            ...options,
            onConsume: onConsume
              ? (tx, event) => onConsume(forwardTransaction(tx), event)
              : undefined,
          }),
        );
      }
    }
    return new BridgeStep();
  }
  return {
    capabilities: {
      dispatchers: Object.fromEntries(
        Object.entries(source.dispatchers).map(([name, provider]) => [
          name,
          new BridgeProvider(provider),
        ]),
      ),
      stepTarget: source.stepTarget === null ? null : forwardStep(source.stepTarget),
    },
    close() {
      closed = true;
    },
    async settle() {
      while (pending.size > 0) {
        await Promise.allSettled(pending);
      }
      return null;
    },
  };
}
