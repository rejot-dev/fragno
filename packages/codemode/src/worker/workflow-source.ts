import { CODEMODE_LIMITS } from "../codemode-limits";
import { normalizeCode } from "../runtime-api";
import { CODEMODE_SANDBOX_CODEC_SOURCE } from "./codemode-guest-source";

/** Generates the same guest workflow API for local and WebSocket-backed host targets. */
export function createRemoteWorkflowWorkerCode(input: {
  code: string;
  providerProxySource: string;
}): string {
  const code = normalizeCode(input.code.trim().replace(/;*$/, "")).trim().replace(/;*$/, "");
  return `
import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
${CODEMODE_SANDBOX_CODEC_SOURCE}
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
const unwrap = (value) => { if (isSuspension(value)) throw value; return value; };
const unsupported = (name) => () => { throw new Error(name); };
const defineTool = (definition) => definition;
class WorkflowAgentToolTarget extends RpcTarget {
  constructor(tools) { super(); this.tools = new Map(tools.map((tool, index) => [\`tool-\${index}\`, tool])); }
  async execute(toolId, toolCallId, input) {
    const tool = this.tools.get(toolId);
    if (!tool || typeof tool.execute !== "function") throw new Error("WORKFLOW_AGENT_TOOL_NOT_FOUND");
    return await tool.execute(toolCallId, input);
  }
}
function createRemoteWorkflowStep(stepTarget, agentTarget) {
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
        const subscription = Promise.resolve(target.onEvent(type, handler));
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
      return unwrap(await stepTarget.do(scopeStorage.getStore() ?? null, name, config, async (target, scope) => {
        return await scopeStorage.run(scope, async () => {
          const tx = wrapTx(target);
          try { return await callback(tx); }
          catch (error) {
            if (isSuspension(error)) return error;
            if (error?.name === "RemoteWorkflowSuspendedError" && error.reason) return { [suspensionKey]: true, reason: error.reason };
            throw error;
          } finally { await tx.__flush(); }
        });
      }));
    },
    sleep: async (name, duration) => unwrap(await stepTarget.sleep(scopeStorage.getStore() ?? null, name, duration)),
    sleepUntil: async (name, timestamp) => unwrap(await stepTarget.sleepUntil(scopeStorage.getStore() ?? null, name, timestamp)),
    waitForEvent: async (name, options) => {
      const remoteOptions = { type: options.type, timeout: options.timeout };
      if (typeof options.onConsume === "function") {
        remoteOptions.onConsume = async (target, event) => {
          const tx = wrapTx(target);
          try { await options.onConsume(tx, event); }
          finally { await tx.__flush(); }
        };
      }
      return unwrap(await stepTarget.waitForEvent(scopeStorage.getStore() ?? null, name, remoteOptions));
    },
    agent: { prompt: async (name, input) => {
      if (!agentTarget) throw new Error("WORKFLOW_AGENT_UNAVAILABLE");
      const tools = input.tools ?? [];
      const definitions = tools.map((tool, index) => ({ id: \`tool-\${index}\`, name: tool.name, description: tool.description, parameters: tool.parameters }));
      return unwrap(await agentTarget.prompt(scopeStorage.getStore() ?? null, name, { text: input.text, images: input.images, tools: definitions }, tools.length ? new WorkflowAgentToolTarget(tools) : null));
    } },
  };
}
export default class RemoteWorkflowEntrypoint extends WorkerEntrypoint {
  async run(event, stepTarget, agentTarget, dispatchers = {}) {
    __dispatchers = dispatchers;
    if (typeof workflowProgram !== "function" && !__isFragnoCodemodeWorkflowDefinition(workflowProgram)) throw new Error("REMOTE_WORKFLOW_CODE_MUST_EVALUATE_TO_FUNCTION");
    try {
      const step = createRemoteWorkflowStep(stepTarget, agentTarget);
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
