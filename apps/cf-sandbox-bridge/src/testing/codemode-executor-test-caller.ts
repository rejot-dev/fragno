import type {
  CodemodeActivation,
  CodemodeWorkflowHost,
  CodemodeWorkflowTransactionHost,
} from "@fragno-dev/codemode/execution/codemode-activation-contract";
import { createCodemodeHost } from "@fragno-dev/codemode/host/codemode-host-capabilities";
import {
  codemodeExecutionService,
  createCodemodeServiceExecutor,
} from "@fragno-dev/codemode/remote/codemode-service-executor";

/**
 * A separate Worker that owns a codemode host, as Backoffice's Codemode object does, and runs each
 * activation through the bridge's `CodemodeExecutor` service binding. Every host capability crosses
 * native Workers RPC twice: caller to bridge, then bridge to guest.
 */
export default {
  async fetch(request: Request, env: { EXECUTOR: Fetcher }): Promise<Response> {
    const parsed = (await request.json()) as CodemodeActivation;
    // JSON carries the workflow event's timestamp as text; the activation contract takes a Date.
    const activation: CodemodeActivation =
      parsed.kind === "workflow"
        ? { ...parsed, event: { ...parsed.event, timestamp: new Date(parsed.event.timestamp) } }
        : parsed;
    const writes: unknown[] = [];
    const emitted: unknown[] = [];
    const consumed: string[] = [];
    const scopes: unknown[] = [];
    const listeners = new Set<Parameters<CodemodeWorkflowTransactionHost["onEvent"]>[1]>();
    const transaction: CodemodeWorkflowTransactionHost = {
      emit(payload) {
        emitted.push(payload);
      },
      async previousEmissions() {
        return [...emitted];
      },
      async previousConsumedEvents() {
        return [];
      },
      workflowServiceCalls() {},
      triggerHook() {},
      onEvent(_type, callback) {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };
    const workflow: CodemodeWorkflowHost = {
      async do(parentScope, name, _config, callback) {
        scopes.push(parentScope);
        const stepKey = parentScope ? `${parentScope.stepKey}>do:${name}` : `do:${name}`;
        return await callback(transaction, {
          stepKey,
          parentStepKey: parentScope?.stepKey ?? null,
          depth: parentScope ? parentScope.depth + 1 : 0,
        });
      },
      async sleep() {
        throw new Error("Unexpected sleep");
      },
      async sleepUntil() {
        throw new Error("Unexpected sleepUntil");
      },
      async waitForEvent(_parentScope, name, options) {
        const event = {
          id: `${name}-1`,
          type: options.type,
          payload: { approved: true },
          timestamp: new Date("2026-01-01T00:00:00.000Z"),
        };
        await options.onConsume?.(transaction, event);
        return event;
      },
    };
    const host = createCodemodeHost(
      [
        {
          name: "store",
          fns: {
            write: async (value) => {
              writes.push(value);
              if (value === "subscribed") {
                // Deliver after this call returns, like a runner delivering a later event.
                setTimeout(() => {
                  for (const listener of listeners) {
                    void listener({
                      id: "ready-1",
                      type: "ready",
                      payload: { value: 42 },
                      timestamp: new Date("2026-01-01T00:00:00.000Z"),
                      consume() {
                        consumed.push("ready-1");
                      },
                    });
                  }
                }, 0);
              }
              return value;
            },
          },
        },
      ],
      activation.kind === "workflow" ? workflow : null,
    );
    const execute = createCodemodeServiceExecutor(codemodeExecutionService(env.EXECUTOR));
    const completion = await execute(activation, host);
    return Response.json({
      completion,
      writes,
      emitted,
      consumed,
      scopes,
      listeners: listeners.size,
    });
  },
};
