import { CODEMODE_LIMITS } from "@fragno-dev/codemode/codemode-limits";
import { decodeCodemodeError } from "@fragno-dev/codemode/transport/codemode-errors";
import { createCodemodeDispatchers } from "@fragno-dev/codemode/worker/codemode-dispatcher";
import {
  DynamicWorkerExecutor,
  type DynamicWorkerRpcCall,
} from "@fragno-dev/codemode/worker/codemode-executor";
import { createCodemodeProviderProxySource } from "@fragno-dev/codemode/worker/codemode-guest-source";
import { createRemoteWorkflowWorkerCode } from "@fragno-dev/codemode/worker/workflow-source";
import {
  RemoteWorkflowSuspendedError,
  type RemoteWorkflowAllowedHook,
  type RemoteWorkflowStepHost,
  type RemoteWorkflowSuspension,
} from "@fragno-dev/workflows/remote-workflow";
import type { RemoteWorkflowRunFn, WorkflowEvent } from "@fragno-dev/workflows/workflow";

import type { NpmDependencyMap } from "@/backoffice-runtime/dynamic-workers/npm-dependencies";
import type {
  BackofficeRuntimeToolFamily,
  BackofficeToolContext,
} from "@/fragno/runtime-tools/runtime-tools";

import {
  createBackofficeCodemodeResolvedProviders,
  resolveBackofficeWorkerCompiler,
  type BackofficeCodemodeEnv,
} from "./execute";
import { createBackofficeCodemodeRemoteHost } from "./remote-execution-host";
import { CodemodeWorkflowAgentTarget, type CodemodeWorkflowAgent } from "./workflow-agent-rpc";
import { WorkflowStepTarget } from "./workflow-rpc";

export type BackofficeCodemodeWorkflowResult<TOutput = unknown> = {
  result?: TOutput;
  error?: string;
};
type WorkflowWorkerResult<TOutput> =
  | { ok: true; result: TOutput }
  | { ok: false; suspension: RemoteWorkflowSuspension };
type CodemodeWorkflowEvent<TParams> = WorkflowEvent<TParams> & { id?: string };
type WorkflowWorkerEntrypoint<TParams, TOutput> = {
  run(
    event: CodemodeWorkflowEvent<TParams>,
    stepTarget: WorkflowStepTarget,
    agentTarget: CodemodeWorkflowAgentTarget | null,
    dispatchers: Record<string, unknown>,
  ): DynamicWorkerRpcCall<WorkflowWorkerResult<TOutput>>;
};

export type BackofficeCodemodeWorkflowOptions = {
  families: readonly BackofficeRuntimeToolFamily[];
  toolContext: BackofficeToolContext;
  /** Hook identities the trusted host permits this sandbox to trigger. */
  allowedHooks: readonly RemoteWorkflowAllowedHook[];
  /** Local sandboxes are sealed unless explicitly granted an allowlisting Fetcher. Remote sandboxes are always sealed. */
  globalOutbound?: Fetcher | null;
  dependencies?: NpmDependencyMap;
  workflowAgent?: CodemodeWorkflowAgent;
};

type WorkflowExecutionInput<TParams> = {
  code: string;
  event: CodemodeWorkflowEvent<TParams>;
  remote: RemoteWorkflowStepHost;
  env: BackofficeCodemodeEnv;
} & BackofficeCodemodeWorkflowOptions;

async function executeBackofficeCodemodeWorkflow<TParams, TOutput>(
  input: WorkflowExecutionInput<TParams>,
): Promise<TOutput> {
  const {
    code,
    event,
    remote,
    env,
    families,
    toolContext,
    globalOutbound,
    dependencies,
    workflowAgent,
    allowedHooks,
  } = input;
  const stepTarget = new WorkflowStepTarget(remote, allowedHooks);
  const agentTarget = workflowAgent ? new CodemodeWorkflowAgentTarget(workflowAgent) : null;
  const providers = await createBackofficeCodemodeResolvedProviders({ families, toolContext });
  try {
    if ("remoteExecutor" in env) {
      if (globalOutbound) {
        throw new Error("CODEMODE_REMOTE_EGRESS_UNSUPPORTED");
      }
      const { host, manifest } = createBackofficeCodemodeRemoteHost(providers, {
        step: stepTarget,
        agent: agentTarget,
      });
      try {
        const completion = await env.remoteExecutor(
          {
            kind: "workflow",
            code,
            dependencies: dependencies ?? {},
            providers: manifest,
            timeoutMs: CODEMODE_LIMITS.activationTimeoutMs,
            event: { ...event, id: event.id ?? event.instanceId },
            agentAvailable: agentTarget !== null,
          },
          host,
        );
        if (completion.status === "suspended") {
          throw new RemoteWorkflowSuspendedError(completion.reason);
        }
        if (completion.status === "failed") {
          throw decodeCodemodeError(completion.error);
        }
        // Workflow output remains opaque until the runner's registered output schema validates it.
        return completion.value as TOutput;
      } finally {
        host.close();
      }
    }
    const dispatcherResult = createCodemodeDispatchers(providers);
    if ("error" in dispatcherResult) {
      throw new Error(dispatcherResult.error);
    }
    const executor = new DynamicWorkerExecutor({
      loader: env.LOADER,
      globalOutbound: globalOutbound ?? null,
    });
    const compiled = await resolveBackofficeWorkerCompiler(env)({
      files: {
        "remote-workflow.js": createRemoteWorkflowWorkerCode({
          code,
          providerProxySource: createCodemodeProviderProxySource(providers),
        }),
      },
      entryPoint: "remote-workflow.js",
      dependencies: dependencies ?? {},
      runtime: { compatibilityDate: "2026-05-07", compatibilityFlags: ["nodejs_als"] },
    });
    const output = await executor.runEntrypoint<
      WorkflowWorkerEntrypoint<TParams, TOutput>,
      WorkflowWorkerResult<TOutput>
    >({
      bundle: compiled.bundle,
      rpcTargets: { agentTarget, dispatchers: dispatcherResult.dispatchers, stepTarget },
      run: (entrypoint, targets) =>
        entrypoint.run(
          { ...event, id: event.id ?? event.instanceId },
          targets.stepTarget as WorkflowStepTarget,
          targets.agentTarget as CodemodeWorkflowAgentTarget | null,
          targets.dispatchers as Record<string, unknown>,
        ),
    });
    if (!output.ok) {
      throw new RemoteWorkflowSuspendedError(output.suspension.reason);
    }
    return output.result;
  } finally {
    agentTarget?.close();
  }
}

/** Runs one activation; suspension stays visible to the workflow runner rather than becoming an error string. */
export async function runBackofficeCodemodeWorkflow<TParams = unknown, TOutput = unknown>(
  input: WorkflowExecutionInput<TParams>,
): Promise<BackofficeCodemodeWorkflowResult<TOutput>> {
  try {
    return { result: await executeBackofficeCodemodeWorkflow<TParams, TOutput>(input) };
  } catch (error) {
    if (error instanceof RemoteWorkflowSuspendedError) {
      throw error;
    }
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Re-evaluates workflow source on each runner tick using Node-owned checkpoints. */
export function defineCodemodeWorkflowRun<TParams = unknown, TOutput = unknown>(
  code: string,
  env: BackofficeCodemodeEnv,
  options: BackofficeCodemodeWorkflowOptions,
): RemoteWorkflowRunFn<TParams, TOutput> {
  return async (event, remote) =>
    await executeBackofficeCodemodeWorkflow<TParams, TOutput>({
      code,
      event,
      remote,
      env,
      ...options,
    });
}
