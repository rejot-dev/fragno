import {
  RemoteWorkflowSuspendedError,
  type RemoteWorkflowStepHost,
  type RemoteWorkflowSuspension,
} from "@fragno-dev/workflows/remote-workflow";
import type { RemoteWorkflowRunFn, WorkflowEvent } from "@fragno-dev/workflows/workflow";

import type { IFileSystem } from "@/files/interface";
import type {
  AnyBackofficeRuntimeTool,
  BackofficeToolContext,
} from "@/fragno/runtime-tools/runtime-tools";

import {
  CODEMODE_SANDBOX_CODEC_SOURCE,
  DynamicWorkerExecutor,
  createCodemodeDispatchers,
  createCodemodeProviderProxySource,
} from "./codemode-executor";
import {
  createBackofficeCodemodeResolvedProviders,
  normalizeBackofficeCodemodeCode,
  type BackofficeCodemodeEnv,
} from "./execute";
import { WorkflowStepTarget } from "./workflow-rpc";

export type BackofficeCodemodeWorkflowResult<TOutput = unknown> = {
  result?: TOutput;
  error?: string;
};

type WorkflowWorkerResult<TOutput> =
  | { ok: true; result: TOutput }
  | { ok: false; suspension: RemoteWorkflowSuspension };

const isRemoteWorkflowSuspendedError = (
  error: unknown,
): error is { reason: RemoteWorkflowSuspension["reason"] } => {
  if (!error || typeof error !== "object" || !("reason" in error)) {
    return false;
  }
  return (
    (error as { name?: unknown }).name === "RemoteWorkflowSuspendedError" ||
    (error as { message?: unknown }).message === "WORKFLOW_STEP_SUSPENDED"
  );
};

type WorkflowWorkerEntrypoint<TParams, TOutput> = {
  run(
    event: WorkflowEvent<TParams>,
    stepTarget: WorkflowStepTarget,
    dispatchers: Record<string, unknown>,
  ): Promise<WorkflowWorkerResult<TOutput>>;
};

export type BackofficeCodemodeWorkflowOptions = {
  fs?: IFileSystem;
  tools?: readonly AnyBackofficeRuntimeTool[];
  context?: BackofficeToolContext;
};

const createRemoteWorkflowWorkerCode = ({
  code,
  providerProxySource,
}: {
  code: string;
  providerProxySource: string;
}) => {
  const executableCode = normalizeBackofficeCodemodeCode(code);
  return `
import { WorkerEntrypoint } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";

${CODEMODE_SANDBOX_CODEC_SOURCE}
let __dispatchers = {};
${providerProxySource}

const workflowProgram = (${executableCode});
const REMOTE_SUSPENSION_KEY = "__fragnoRemoteWorkflowSuspended";

class RemoteWorkflowSuspendedError extends Error {
  constructor(reason) {
    super("WORKFLOW_STEP_SUSPENDED");
    this.name = "RemoteWorkflowSuspendedError";
    this.reason = reason;
  }
}

const createRemoteWorkflowSuspension = (reason) => ({
  [REMOTE_SUSPENSION_KEY]: true,
  reason,
});

const isRemoteWorkflowSuspension = (value) =>
  Boolean(value) &&
  typeof value === "object" &&
  value[REMOTE_SUSPENSION_KEY] === true &&
  "reason" in value;

const isRemoteWorkflowSuspendedError = (error) =>
  Boolean(error) &&
  typeof error === "object" &&
  "reason" in error &&
  (error.name === "RemoteWorkflowSuspendedError" || error.message === "WORKFLOW_STEP_SUSPENDED");

const unwrapRemoteStepResult = (result) => {
  if (isRemoteWorkflowSuspension(result)) {
    throw result;
  }
  return result;
};

const normalizeStepDoArgs = (configOrCallback, maybeCallback) => {
  if (typeof configOrCallback === "function") {
    return { config: undefined, callback: configOrCallback };
  }
  return { config: configOrCallback, callback: maybeCallback };
};

const createUnsupportedTxMethod = (name) => () => {
  throw new Error(name);
};

const createRemoteWorkflowStep = (stepTarget) => {
  const scopeStorage = new AsyncLocalStorage();

  const wrapTx = (txTarget) => {
    const pending = [];
    const queue = (operation) => {
      pending.push(Promise.resolve(operation));
    };

    return {
      emit: (payload) => queue(txTarget.emit(payload)),
      previousEmissions: async () => await txTarget.previousEmissions(),
      workflowServiceCalls: (factory) => queue(txTarget.workflowServiceCalls(factory())),
      onEvent: (type, handler) => {
        let active = true;
        const unsubscribePromise = txTarget.onEvent(type, handler);
        return () => {
          active = false;
          unsubscribePromise.then((unsubscribe) => {
            if (!active && typeof unsubscribe === "function") {
              unsubscribe();
            }
          });
        };
      },
      mutate: createUnsupportedTxMethod("REMOTE_WORKFLOW_TX_MUTATE_UNSUPPORTED"),
      serviceCalls: createUnsupportedTxMethod("REMOTE_WORKFLOW_TX_SERVICE_CALLS_UNSUPPORTED"),
      onTerminalError: {
        mutate: createUnsupportedTxMethod("REMOTE_WORKFLOW_TX_ON_TERMINAL_ERROR_MUTATE_UNSUPPORTED"),
      },
      __flush: async () => {
        await Promise.all(pending);
      },
    };
  };

  const step = {
    do: async (name, configOrCallback, maybeCallback) => {
      const { config, callback } = normalizeStepDoArgs(configOrCallback, maybeCallback);
      if (typeof callback !== "function") {
        throw new Error("WORKFLOW_STEP_CALLBACK_REQUIRED");
      }
      const parentScope = scopeStorage.getStore() ?? null;
      const result = await stepTarget.do(parentScope, name, config, async (txTarget, childScope) => {
        return await scopeStorage.run(childScope, async () => {
          try {
            const tx = wrapTx(txTarget);
            const result = await callback(tx);
            await tx.__flush();
            return result;
          } catch (error) {
            if (isRemoteWorkflowSuspension(error)) {
              return error;
            }
            if (isRemoteWorkflowSuspendedError(error)) {
              return createRemoteWorkflowSuspension(error.reason);
            }
            throw error;
          }
        });
      });
      return unwrapRemoteStepResult(result);
    },
    sleep: async (name, duration) => {
      const parentScope = scopeStorage.getStore() ?? null;
      unwrapRemoteStepResult(await stepTarget.sleep(parentScope, name, duration));
    },
    sleepUntil: async (name, timestamp) => {
      const parentScope = scopeStorage.getStore() ?? null;
      unwrapRemoteStepResult(await stepTarget.sleepUntil(parentScope, name, timestamp));
    },
    waitForEvent: async (name, options) => {
      const parentScope = scopeStorage.getStore() ?? null;
      const remoteOptions = {
        type: options.type,
        timeout: options.timeout,
      };
      if (typeof options.onConsume === "function") {
        remoteOptions.onConsume = async (txTarget, event) => {
          const tx = wrapTx(txTarget);
          await options.onConsume(tx, event);
          await tx.__flush();
        };
      }
      return unwrapRemoteStepResult(await stepTarget.waitForEvent(parentScope, name, remoteOptions));
    },
  };

  return step;
};

export default class RemoteWorkflowEntrypoint extends WorkerEntrypoint {
  async run(event, stepTarget, dispatchers = {}) {
    __dispatchers = dispatchers;
    if (typeof workflowProgram !== "function") {
      throw new Error("REMOTE_WORKFLOW_CODE_MUST_EVALUATE_TO_FUNCTION");
    }
    try {
      const step = createRemoteWorkflowStep(stepTarget);
      const definitionOrResult = workflowProgram.length >= 2
        ? workflowProgram
        : await workflowProgram();
      const runWorkflow = __isFragnoCodemodeWorkflowDefinition(definitionOrResult)
        ? definitionOrResult.run
        : definitionOrResult;
      if (typeof runWorkflow !== "function") {
        throw new Error("REMOTE_WORKFLOW_CODE_MUST_DEFINE_WORKFLOW");
      }
      return { ok: true, result: await runWorkflow(event, step) };
    } catch (error) {
      if (isRemoteWorkflowSuspension(error)) {
        return { ok: false, suspension: error };
      }
      if (isRemoteWorkflowSuspendedError(error)) {
        return { ok: false, suspension: createRemoteWorkflowSuspension(error.reason) };
      }
      throw error;
    }
  }
}
`;
};

const executeBackofficeCodemodeWorkflow = async <TParams = unknown, TOutput = unknown>({
  code,
  event,
  remote,
  env,
  fs,
  tools,
  context,
}: {
  code: string;
  event: WorkflowEvent<TParams>;
  remote: RemoteWorkflowStepHost;
  env: BackofficeCodemodeEnv;
} & BackofficeCodemodeWorkflowOptions): Promise<TOutput> => {
  const stepTarget = new WorkflowStepTarget(remote);
  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    globalOutbound: null,
  });

  const providers = createBackofficeCodemodeResolvedProviders({ fs, tools, context });
  const dispatcherResult = createCodemodeDispatchers(providers);
  if ("error" in dispatcherResult) {
    throw new Error(dispatcherResult.error);
  }
  const { dispatchers } = dispatcherResult;

  const output = await executor.runEntrypoint<
    WorkflowWorkerEntrypoint<TParams, TOutput>,
    WorkflowWorkerResult<TOutput>
  >({
    compatibilityDate: "2026-05-07",
    compatibilityFlags: ["nodejs_als"],
    mainModule: "remote-workflow.js",
    modules: {
      "remote-workflow.js": createRemoteWorkflowWorkerCode({
        code,
        providerProxySource: createCodemodeProviderProxySource(providers),
      }),
    },
    rpcTargets: { dispatchers, stepTarget },
    run: async (entrypoint, rpcTargets) =>
      await entrypoint.run(
        event,
        rpcTargets.stepTarget as WorkflowStepTarget,
        rpcTargets.dispatchers as Record<string, unknown>,
      ),
  });
  if (!output.ok) {
    throw new RemoteWorkflowSuspendedError(output.suspension.reason);
  }
  return output.result;
};

export const runBackofficeCodemodeWorkflow = async <TParams = unknown, TOutput = unknown>(
  input: {
    code: string;
    event: WorkflowEvent<TParams>;
    remote: RemoteWorkflowStepHost;
    env: BackofficeCodemodeEnv;
  } & BackofficeCodemodeWorkflowOptions,
): Promise<BackofficeCodemodeWorkflowResult<TOutput>> => {
  try {
    return { result: await executeBackofficeCodemodeWorkflow<TParams, TOutput>(input) };
  } catch (error) {
    if (isRemoteWorkflowSuspendedError(error)) {
      throw error;
    }
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

export const defineCodemodeWorkflowRun = <TParams = unknown, TOutput = unknown>(
  code: string,
  env: BackofficeCodemodeEnv,
  options: BackofficeCodemodeWorkflowOptions = {},
): RemoteWorkflowRunFn<TParams, TOutput> => {
  return async (event, remote) => {
    return await executeBackofficeCodemodeWorkflow<TParams, TOutput>({
      code,
      event,
      remote,
      env,
      ...options,
    });
  };
};
