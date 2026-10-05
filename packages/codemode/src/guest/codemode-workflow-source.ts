import { CODEMODE_LIMITS } from "../codemode-limits";
import { normalizeCode } from "../runtime-api";
import { CODEMODE_GUEST_API_SOURCE } from "./codemode-guest-api-source";

/** Generates the same guest workflow API for local and WebSocket-backed host targets. */
export function createCodemodeWorkflowSource(input: {
  code: string;
  providerProxySource: string;
}): string {
  const code = normalizeCode(input.code.trim().replace(/;*$/, "")).trim().replace(/;*$/, "");
  return `
import { WorkerEntrypoint } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
${CODEMODE_GUEST_API_SOURCE}
let __dispatchers = {};
${input.providerProxySource}
const logs = [];
let logBytes = 0;
const captureLog = (prefix, args) => {
  const text = prefix + args.map(String).join(" ");
  logBytes += new TextEncoder().encode(text).byteLength;
  if (logs.length >= ${CODEMODE_LIMITS.maxLogs} || logBytes > ${CODEMODE_LIMITS.maxLogBytes}) throw new Error("CODEMODE_LOG_LIMIT_EXCEEDED");
  logs.push(text);
};
console.log = (...args) => captureLog("", args);
console.warn = (...args) => captureLog("[warn] ", args);
console.error = (...args) => captureLog("[error] ", args);
const workflowProgram = (${code});
const suspensionKey = "__fragnoRemoteWorkflowSuspended";
const isSuspension = (value) => Boolean(value) && typeof value === "object" && value[suspensionKey] === true && "reason" in value;
const unwrap = (result) => {
  if (result.status === "suspended") throw { [suspensionKey]: true, reason: result.reason };
  if (result.status === "error") __throwCodemodeProviderError(result.error);
  return result.value;
};
const unsupported = (name) => () => { throw new Error(name); };
function createRemoteWorkflowStep(stepTarget) {
  const scopeStorage = new AsyncLocalStorage();
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
  return {
    do: async (name, configOrCallback, maybeCallback) => {
      const config = typeof configOrCallback === "function" ? undefined : configOrCallback;
      const callback = typeof configOrCallback === "function" ? configOrCallback : maybeCallback;
      if (typeof callback !== "function") throw new Error("WORKFLOW_STEP_CALLBACK_REQUIRED");
      return unwrap(await (scopeStorage.getStore() ?? stepTarget).do(name, config, async (target, scopedStep) => {
        return await scopeStorage.run(scopedStep, async () => {
          const tx = wrapTx(target);
          let value;
          try {
            try { value = await callback(tx); }
            catch (error) {
              if (isSuspension(error)) value = error;
              else if (error?.name === "RemoteWorkflowSuspendedError" && error.reason) value = { [suspensionKey]: true, reason: error.reason };
              else throw error;
            } finally { await tx.__flush(); }
            return { status: "ok", value };
          } catch (error) { return __codemodeCallbackFailure(error); }
        });
      }));
    },
    sleep: async (name, duration) => unwrap(await (scopeStorage.getStore() ?? stepTarget).sleep(name, duration)),
    sleepUntil: async (name, timestamp) => unwrap(await (scopeStorage.getStore() ?? stepTarget).sleepUntil(name, timestamp)),
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
      return unwrap(await (scopeStorage.getStore() ?? stepTarget).waitForEvent(name, remoteOptions));
    },
  };
}
export default class RemoteWorkflowEntrypoint extends WorkerEntrypoint {
  async run(event, stepTarget, dispatchers = {}) {
    __dispatchers = dispatchers;
    if (typeof workflowProgram !== "function" && !__isFragnoCodemodeWorkflowDefinition(workflowProgram)) throw new Error("REMOTE_WORKFLOW_CODE_MUST_EVALUATE_TO_FUNCTION");
    try {
      const step = createRemoteWorkflowStep(stepTarget);
      const definition = __isFragnoCodemodeWorkflowDefinition(workflowProgram) || workflowProgram.length >= 2 ? workflowProgram : await workflowProgram();
      const run = __isFragnoCodemodeWorkflowDefinition(definition) ? definition.run : definition;
      if (typeof run !== "function") throw new Error("REMOTE_WORKFLOW_CODE_MUST_DEFINE_WORKFLOW");
      return { ok: true, result: await run(event, step), logs };
    } catch (error) {
      if (isSuspension(error)) return { ok: false, suspension: error, logs };
      if (error?.name === "RemoteWorkflowSuspendedError" && error.reason) return { ok: false, suspension: { [suspensionKey]: true, reason: error.reason }, logs };
      throw error;
    }
  }
}
`;
}
