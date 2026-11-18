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
    const parsed = await request.json<CodemodeActivation>();
    // JSON carries the workflow event's timestamp as text; the activation contract takes a Date.
    const activation: CodemodeActivation =
      parsed.kind === "workflow"
        ? { ...parsed, event: { ...parsed.event, timestamp: new Date(parsed.event.timestamp) } }
        : parsed;
    const writes: unknown[] = [];
    const emitted: unknown[] = [];
    const consumed: string[] = [];
    const steps: string[] = [];
    let nextOrder = 0;
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
      async do(name, _config, callback) {
        steps.push(name);
        const value = await callback(transaction);
        const order = nextOrder++;
        if (name === "first") {
          // Settled first, but its outcome reaches the guest after a later step's.
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 50);
          });
        }
        return { type: "settled", ok: true, value, order };
      },
      async sleep() {
        throw new Error("Unexpected sleep");
      },
      async sleepUntil() {
        throw new Error("Unexpected sleepUntil");
      },
      async waitForEvent(name, options) {
        const event = {
          id: `${name}-1`,
          type: options.type,
          payload: { approved: true },
          timestamp: new Date("2026-01-01T00:00:00.000Z"),
        };
        await options.onConsume?.(transaction, event);
        return { type: "settled", ok: true, value: event, order: nextOrder++ };
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
      steps,
      listeners: listeners.size,
    });
  },
};
