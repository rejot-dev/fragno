import { createWorkflowTick } from "@fragno-dev/workflows/workflow-tick";

import { CODEMODE_LIMITS } from "../codemode-limits";
import type { ResolvedProvider } from "../runtime-api";
import {
  CODEMODE_GUEST_API_SOURCE,
  createCodemodeProviderGlobalsSource,
  createCodemodeProviderProxySource,
} from "./codemode-guest-api-source";

/**
 * Generates a guest that runs the workflow its entry module exports by default. The entry is a
 * module like any saved program, so it imports others statically, by absolute or relative path.
 */
export function createCodemodeWorkflowSource(input: {
  modulePath: string;
  providers: readonly ResolvedProvider[];
}): string {
  return `
import { WorkerEntrypoint } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
${CODEMODE_GUEST_API_SOURCE}
let __dispatchers = {};
${createCodemodeProviderProxySource(input.providers)}
${createCodemodeProviderGlobalsSource(input.providers)}
const logs = [];
let logBytes = 0;
let logsTruncated = false;
// Logs past the limits are dropped rather than thrown, so a chatty step still completes.
const captureLog = (channel, args) => {
  if (logsTruncated) return;
  const text = args.map(String).join(" ");
  logBytes += new TextEncoder().encode(text).byteLength;
  if (logs.length >= ${CODEMODE_LIMITS.maxLogs - 1} || logBytes > ${CODEMODE_LIMITS.maxLogBytes}) {
    logsTruncated = true;
    logs.push({ at: Date.now(), channel: "codemode", text: "Logs truncated." });
    return;
  }
  logs.push({ at: Date.now(), channel, text });
};
for (const channel of ["log", "info", "debug", "warn", "error"]) {
  console[channel] = (...args) => captureLog(channel, args);
}
// esbuild's keepNames wraps named functions in __name calls, which the embedded source keeps.
const __name = (target) => target;
const createWorkflowTick = (${createWorkflowTick.toString()});
const unsupported = (name) => () => { throw new Error(name); };
const never = () => new Promise(() => {});
// The host reports a waiting step as parked, and every failure as a settled step failure.
const outcomeOf = (result) => {
  if (result.status === "parked") return { type: "parked" };
  return result.result.status === "ok"
    ? { type: "settled", ok: true, value: result.result.value, order: result.order }
    : { type: "settled", ok: false, error: __codemodeProviderError(result.result.error), order: result.order };
};
function createRemoteWorkflowStep(stepTarget, settledOrders) {
  // The workflow code's tick runs here, beside it: only this realm can tell when the code stops
  // making progress. The host runs each step and reports its outcome without waiting for its turn.
  const tick = createWorkflowTick(settledOrders);
  const running = new AsyncLocalStorage();
  const call = (name, invoke) => {
    // After the tick, a call can neither run nor be recorded.
    if (tick.ended() !== null) return never();
    const parent = running.getStore();
    if (parent !== undefined) {
      const error = new Error("WORKFLOW_STEP_NESTED_IN_DO: step " + JSON.stringify(name) + " was called inside step " + JSON.stringify(parent) + ". A step.do callback does the step's work and cannot call other steps.");
      error.name = "NonRetryableError";
      return Promise.reject(error);
    }
    return tick.call(async () => outcomeOf(await invoke(stepTarget)));
  };
  // Callbacks arrive as their own RPC calls, outside the call that started their step, so each one
  // re-enters its step: a step's callbacks cannot call other steps.
  const wrapTx = (target, stepName) => {
    const pending = [];
    const queue = (operation) => {
      const promise = Promise.resolve(operation);
      // Queued intents are observed at flush, but can reject before the callback returns.
      promise.catch(() => {});
      pending.push(promise);
    };
    return {
      emit: (payload) => queue(target.emit(payload)),
      previousEmissions: async () => await target.previousEmissions(),
      previousConsumedEvents: async () => await target.previousConsumedEvents(),
      workflowServiceCalls: (factory) => queue(target.workflowServiceCalls(factory())),
      triggerHook: (operation) => queue(target.triggerHook(operation)),
      onEvent: (type, handler) => {
        let active = true;
        const subscription = Promise.resolve(target.onEvent(type, async (event) => {
          if (!active) return { status: "ok", value: false };
          let consumed = false;
          let delivering = true;
          try {
            await running.run(stepName, async () => await handler({ ...event, consume() {
              if (!delivering) throw new Error("CODEMODE_EVENT_DELIVERY_ENDED");
              consumed = true;
            } }));
            return { status: "ok", value: active && consumed };
          } catch (error) { return __codemodeCallbackFailure(error); }
          finally { delivering = false; }
        }));
        queue(subscription);
        return () => {
          if (!active) return;
          active = false;
          queue(subscription.then((unsubscribe) => unsubscribe()));
        };
      },
      mutate: unsupported("REMOTE_WORKFLOW_TX_MUTATE_UNSUPPORTED"),
      serviceCalls: unsupported("REMOTE_WORKFLOW_TX_SERVICE_CALLS_UNSUPPORTED"),
      onTerminalError: { mutate: unsupported("REMOTE_WORKFLOW_TX_ON_TERMINAL_ERROR_MUTATE_UNSUPPORTED") },
      __flush: async () => {
        for (const result of await Promise.allSettled(pending)) {
          if (result.status === "rejected") throw result.reason;
        }
      },
    };
  };
  const step = {
    do: (name, configOrCallback, maybeCallback) => {
      const config = typeof configOrCallback === "function" ? undefined : configOrCallback;
      const callback = typeof configOrCallback === "function" ? configOrCallback : maybeCallback;
      if (typeof callback !== "function") return Promise.reject(new Error("WORKFLOW_STEP_CALLBACK_REQUIRED"));
      return call(name, (target) => target.do(name, config, async (txTarget) =>
        await running.run(name, async () => {
          const tx = wrapTx(txTarget, name);
          try {
            let value;
            try { value = await callback(tx); }
            finally { await tx.__flush(); }
            return { status: "ok", value };
          } catch (error) { return __codemodeCallbackFailure(error); }
        })));
    },
    sleep: (name, duration) => call(name, (target) => target.sleep(name, duration)),
    sleepUntil: (name, timestamp) => call(name, (target) => target.sleepUntil(name, timestamp)),
    waitForEvent: (name, options) => {
      const remoteOptions = { type: options.type, timeout: options.timeout };
      if (typeof options.onConsume === "function") {
        remoteOptions.onConsume = async (target, event) =>
          await running.run(name, async () => {
            const tx = wrapTx(target, name);
            try {
              try { await options.onConsume(tx, event); }
              finally { await tx.__flush(); }
              return { status: "ok", value: undefined };
            } catch (error) { return __codemodeCallbackFailure(error); }
          });
      }
      return call(name, (target) => target.waitForEvent(name, remoteOptions));
    },
  };
  return { step, tick };
}
export default class RemoteWorkflowEntrypoint extends WorkerEntrypoint {
  async run(event, stepTarget, dispatchers, settledOrders) {
    __dispatchers = dispatchers;
    // Modules evaluate in their own scope, so the entry reaches defineWorkflow as a global.
    globalThis.defineWorkflow = defineWorkflow;
    const definition = (await import(${JSON.stringify(input.modulePath)})).default;
    if (!__isFragnoCodemodeWorkflowDefinition(definition)) {
      throw new Error("CODEMODE_WORKFLOW_DEFINITION_MISSING: the workflow module must export default defineWorkflow(...).");
    }
    const workflow = createRemoteWorkflowStep(stepTarget, settledOrders);
    const end = await workflow.tick.run(() => definition.run(event, workflow.step));
    if (end.type === "returned") return { ok: true, result: end.value, logs };
    if (end.type === "threw") throw end.error;
    return { ok: false, logs };
  }
}
`;
}
