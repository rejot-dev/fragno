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
const suspensionKey = "__fragnoRemoteWorkflowSuspended";
const isSuspension = (value) => Boolean(value) && typeof value === "object" && value[suspensionKey] === true && "reason" in value;
const unwrap = (result) => {
  if (result.status === "suspended") throw { [suspensionKey]: true, reason: result.reason };
  if (result.status === "error") __throwCodemodeProviderError(result.error);
  return result.value;
};
const unsupported = (name) => () => { throw new Error(name); };
function createRemoteWorkflowStep(stepTarget) {
  // A scope is the workflow body or one step's callback, with the steps started in it still running.
  const root = { target: stepTarget, running: new Set() };
  const scopeStorage = new AsyncLocalStorage();
  const currentScope = () => scopeStorage.getStore() ?? root;
  const track = (scope, operation) => {
    const call = Promise.resolve(operation(scope.target));
    scope.running.add(call);
    const untrack = () => scope.running.delete(call);
    call.then(untrack, untrack);
    return call;
  };
  // A scope ends only once the steps started in it settle. One branch of a Promise.all suspending
  // or failing must not end its siblings' steps: the host revokes the scope's capabilities when it
  // ends, and their results would be lost with the tick.
  const settle = async (scope) => {
    while (scope.running.size > 0) await Promise.allSettled(scope.running);
  };
  const wrapTx = (target) => {
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
            await handler({ ...event, consume() {
              if (!delivering) throw new Error("CODEMODE_EVENT_DELIVERY_ENDED");
              consumed = true;
            } });
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
    do: async (name, configOrCallback, maybeCallback) => {
      const config = typeof configOrCallback === "function" ? undefined : configOrCallback;
      const callback = typeof configOrCallback === "function" ? configOrCallback : maybeCallback;
      if (typeof callback !== "function") throw new Error("WORKFLOW_STEP_CALLBACK_REQUIRED");
      return unwrap(await track(currentScope(), (target) => target.do(name, config, async (txTarget, scopedStep) => {
        const scope = { target: scopedStep, running: new Set() };
        return await scopeStorage.run(scope, async () => {
          const tx = wrapTx(txTarget);
          let value;
          try {
            try { value = await callback(tx); }
            catch (error) {
              if (isSuspension(error)) value = error;
              else if (error?.name === "RemoteWorkflowSuspendedError" && error.reason) value = { [suspensionKey]: true, reason: error.reason };
              else throw error;
            } finally {
              await settle(scope);
              await tx.__flush();
            }
            return { status: "ok", value };
          } catch (error) { return __codemodeCallbackFailure(error); }
        });
      })));
    },
    sleep: async (name, duration) => unwrap(await track(currentScope(), (target) => target.sleep(name, duration))),
    sleepUntil: async (name, timestamp) => unwrap(await track(currentScope(), (target) => target.sleepUntil(name, timestamp))),
    waitForEvent: async (name, options) => {
      const remoteOptions = { type: options.type, timeout: options.timeout };
      if (typeof options.onConsume === "function") {
        remoteOptions.onConsume = async (target, event) => {
          const tx = wrapTx(target);
          try {
            try { await options.onConsume(tx, event); }
            finally { await tx.__flush(); }
            return { status: "ok", value: undefined };
          } catch (error) { return __codemodeCallbackFailure(error); }
        };
      }
      return unwrap(await track(currentScope(), (target) => target.waitForEvent(name, remoteOptions)));
    },
  };
  return { step, settle: () => settle(root) };
}
export default class RemoteWorkflowEntrypoint extends WorkerEntrypoint {
  async run(event, stepTarget, dispatchers = {}) {
    __dispatchers = dispatchers;
    // Modules evaluate in their own scope, so the entry reaches defineWorkflow as a global.
    globalThis.defineWorkflow = defineWorkflow;
    const definition = (await import(${JSON.stringify(input.modulePath)})).default;
    if (!__isFragnoCodemodeWorkflowDefinition(definition)) {
      throw new Error("CODEMODE_WORKFLOW_DEFINITION_MISSING: the workflow module must export default defineWorkflow(...).");
    }
    const workflow = createRemoteWorkflowStep(stepTarget);
    try {
      let result;
      try { result = await definition.run(event, workflow.step); }
      finally { await workflow.settle(); }
      return { ok: true, result, logs };
    } catch (error) {
      if (isSuspension(error)) return { ok: false, suspension: error, logs };
      if (error?.name === "RemoteWorkflowSuspendedError" && error.reason) return { ok: false, suspension: { [suspensionKey]: true, reason: error.reason }, logs };
      throw error;
    }
  }
}
`;
}
