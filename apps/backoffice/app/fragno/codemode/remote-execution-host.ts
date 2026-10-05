import { CODEMODE_LIMITS } from "@fragno-dev/codemode/codemode-limits";
import { sanitizeToolName, type ResolvedProvider } from "@fragno-dev/codemode/runtime-api";
import {
  codemodeSuspensionReasonSchema,
  type CodemodeRemoteExecutor,
  type CodemodeHostOperation,
  type CodemodeGuestOperation,
  type CodemodeSuspensionReason,
} from "@fragno-dev/codemode/transport/codemode-protocol";
import { createCodemodeDispatchers } from "@fragno-dev/codemode/worker/codemode-dispatcher";
import {
  isRemoteWorkflowSuspension,
  RemoteWorkflowSuspendedError,
} from "@fragno-dev/workflows/remote-workflow";
import { z } from "zod";

import type { WorkflowStepTarget } from "./workflow-rpc";

type WorkflowTxTarget = Parameters<Parameters<WorkflowStepTarget["do"]>[3]>[0];
type GuestCall = (call: CodemodeGuestOperation) => Promise<unknown>;
type Subscription = { txId: number; active: boolean; dispose(): void };

/** Holds Node-owned authorization and transaction capabilities for exactly one activation. */
export function createBackofficeCodemodeRemoteHost(
  providers: ResolvedProvider[],
  workflow: { step: WorkflowStepTarget } | null,
) {
  const result = createCodemodeDispatchers(providers);
  if ("error" in result) {
    throw new Error(result.error);
  }
  const { dispatchers } = result;
  const transactions = new Map<number, WorkflowTxTarget>();
  const subscriptions = new Map<number, Subscription>();
  const pending = new Set<Promise<unknown>>();
  const scopes = new Map<
    number,
    NonNullable<Extract<CodemodeHostOperation, { operation: "step.do" }>["parentScope"]>
  >();
  let nextId = 0;
  let closed = false;
  let suspension: CodemodeSuspensionReason | null = null;
  const issuedSuspensions = new Set<string>();

  function releaseTransaction(txId: number) {
    transactions.delete(txId);
    scopes.delete(txId);
    for (const [id, subscription] of subscriptions) {
      if (subscription.txId !== txId) {
        continue;
      }
      subscription.active = false;
      subscription.dispose();
      subscriptions.delete(id);
    }
  }
  function registerTransaction(tx: WorkflowTxTarget) {
    if (closed) {
      throw new Error("CODEMODE_HOST_CLOSED");
    }
    if (transactions.size + subscriptions.size >= CODEMODE_LIMITS.maxHandles) {
      throw new Error("CODEMODE_HOST_HANDLE_LIMIT_EXCEEDED");
    }
    const id = ++nextId;
    transactions.set(id, tx);
    return id;
  }
  function unwrapHostOutcome(value: unknown) {
    if (isRemoteWorkflowSuspension(value)) {
      suspension = codemodeSuspensionReasonSchema.parse(value.reason);
      issuedSuspensions.add(JSON.stringify(suspension));
      throw new RemoteWorkflowSuspendedError(suspension);
    }
    return value;
  }
  async function dispatch(call: CodemodeHostOperation, guest: GuestCall): Promise<unknown> {
    if (closed) {
      throw new Error("CODEMODE_HOST_CLOSED");
    }
    if (call.operation === "provider.call") {
      if (!Object.hasOwn(dispatchers, call.provider)) {
        throw new Error("CODEMODE_PROVIDER_NOT_EXPOSED");
      }
      return await dispatchers[call.provider].call(call.tool, call.argsJson);
    }
    if (!workflow) {
      throw new Error("CODEMODE_WORKFLOW_UNAVAILABLE");
    }
    if ("parentScope" in call && call.parentScope !== null) {
      const scope = call.parentScope;
      if (
        ![...scopes.values()].some(
          (active) =>
            active.stepKey === scope.stepKey &&
            active.parentStepKey === scope.parentStepKey &&
            active.depth === scope.depth,
        )
      ) {
        throw new Error("CODEMODE_WORKFLOW_SCOPE_NOT_ACTIVE");
      }
    }
    switch (call.operation) {
      case "step.do":
        return unwrapHostOutcome(
          await workflow.step.do(
            call.parentScope,
            call.name,
            call.config ?? undefined,
            async (tx, scope) => {
              const txId = registerTransaction(tx);
              scopes.set(txId, scope);
              try {
                const result = await guest({
                  operation: "callback.step",
                  callbackId: call.callbackId,
                  txId,
                  scope,
                });
                if (isRemoteWorkflowSuspension(result)) {
                  const reason = codemodeSuspensionReasonSchema.parse(result.reason);
                  if (!issuedSuspensions.has(JSON.stringify(reason))) {
                    throw new Error("CODEMODE_UNISSUED_SUSPENSION");
                  }
                }
                return result;
              } finally {
                releaseTransaction(txId);
              }
            },
          ),
        );
      case "step.sleep":
        return unwrapHostOutcome(
          await workflow.step.sleep(call.parentScope, call.name, call.duration),
        );
      case "step.sleepUntil":
        return unwrapHostOutcome(
          await workflow.step.sleepUntil(call.parentScope, call.name, call.timestamp),
        );
      case "step.waitForEvent":
        return unwrapHostOutcome(
          await workflow.step.waitForEvent(call.parentScope, call.name, {
            type: call.eventType,
            timeout: call.timeout ?? undefined,
            onConsume:
              call.callbackId === null
                ? undefined
                : async (tx, event) => {
                    const txId = registerTransaction(tx);
                    try {
                      await guest({
                        operation: "callback.consume",
                        callbackId: call.callbackId!,
                        txId,
                        event,
                      });
                    } finally {
                      releaseTransaction(txId);
                    }
                  },
          }),
        );
      case "tx.emit":
      case "tx.previousEmissions":
      case "tx.previousConsumedEvents":
      case "tx.workflowServiceCalls":
      case "tx.triggerHook":
      case "tx.unsubscribe":
      case "tx.onEvent": {
        const tx = transactions.get(call.txId);
        if (!tx) {
          throw new Error("REMOTE_WORKFLOW_TX_NOT_FOUND");
        }
        switch (call.operation) {
          case "tx.emit": {
            tx.emit(call.payload);
            return undefined;
          }
          case "tx.previousEmissions":
            return await tx.previousEmissions();
          case "tx.previousConsumedEvents":
            return await tx.previousConsumedEvents();
          case "tx.workflowServiceCalls": {
            tx.workflowServiceCalls(call.operations);
            return undefined;
          }
          case "tx.triggerHook": {
            tx.triggerHook(call.intent);
            return undefined;
          }
          case "tx.unsubscribe": {
            const subscription = subscriptions.get(call.subscriptionId);
            if (!subscription || subscription.txId !== call.txId) {
              throw new Error("CODEMODE_SUBSCRIPTION_NOT_FOUND");
            }
            subscription.active = false;
            subscription.dispose();
            subscriptions.delete(call.subscriptionId);
            return undefined;
          }
          case "tx.onEvent": {
            if (subscriptions.size + transactions.size >= CODEMODE_LIMITS.maxHandles) {
              throw new Error("CODEMODE_HOST_HANDLE_LIMIT_EXCEEDED");
            }
            const id = ++nextId;
            const subscription: Subscription = { txId: call.txId, active: true, dispose: () => {} };
            subscriptions.set(id, subscription);
            try {
              subscription.dispose = tx.onEvent(call.eventType, async (event) => {
                if (!subscription.active || closed) {
                  return;
                }
                const deliveryId = ++nextId;
                const returned = await guest({
                  operation: "callback.event",
                  callbackId: call.callbackId,
                  deliveryId,
                  event: {
                    id: event.id,
                    type: event.type,
                    payload: event.payload,
                    timestamp: event.timestamp,
                  },
                });
                const result = z
                  .strictObject({ deliveryId: z.literal(deliveryId), consumed: z.boolean() })
                  .parse(returned);
                if (
                  result.consumed &&
                  subscription.active &&
                  !closed &&
                  transactions.has(call.txId)
                ) {
                  event.consume();
                }
              });
              return id;
            } catch (error) {
              subscriptions.delete(id);
              throw error;
            }
          }
          default:
            throw new Error("CODEMODE_UNKNOWN_HOST_OPERATION", { cause: call satisfies never });
        }
      }
      default:
        throw new Error("CODEMODE_UNKNOWN_HOST_OPERATION", { cause: call satisfies never });
    }
  }
  const host: Parameters<CodemodeRemoteExecutor>[1] = {
    handle(call, guest) {
      const task = dispatch(call, guest);
      pending.add(task);
      void task.then(
        () => pending.delete(task),
        () => pending.delete(task),
      );
      return task;
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      for (const txId of transactions.keys()) {
        releaseTransaction(txId);
      }
    },
    async settle() {
      await Promise.allSettled(pending);
      return suspension;
    },
  };
  return {
    host,
    manifest: providers.map((provider) => ({
      name: provider.name,
      tools: Object.keys(provider.fns).map(sanitizeToolName),
    })),
  };
}
