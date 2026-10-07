import { CODEMODE_LIMITS } from "@fragno-dev/codemode/codemode-limits";
import type { CodemodeStepCapability } from "@fragno-dev/codemode/execution/codemode-activation-contract";
import { decodeCodemodeError } from "@fragno-dev/codemode/execution/codemode-errors";
import { createCodemodeProviderProxySource } from "@fragno-dev/codemode/guest/codemode-guest-api-source";
import {
  DynamicWorkerExecutor,
  type DynamicWorkerRpcCall,
} from "@fragno-dev/codemode/guest/codemode-worker-executor";
import { createCodemodeWorkflowSource } from "@fragno-dev/codemode/guest/codemode-workflow-source";
import { createCodemodeHost } from "@fragno-dev/codemode/host/codemode-host-capabilities";
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
import { explainMcpCodemodeError } from "./mcp-codemode-tools";
import { createBackofficeCodemodeRemoteHost } from "./remote-execution-host";
import { BackofficeWorkflowStepHost } from "./workflow-host";

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
    stepTarget: CodemodeStepCapability,
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
    allowedHooks,
  } = input;
  const { providers, mcpDiscoveryError } = await createBackofficeCodemodeResolvedProviders({
    families,
    toolContext,
  });
  const stepTarget = new BackofficeWorkflowStepHost(remote, allowedHooks, (error) =>
    explainMcpCodemodeError(mcpDiscoveryError, error),
  );
  if ("remoteExecutor" in env) {
    if (globalOutbound) {
      throw new Error("CODEMODE_REMOTE_EGRESS_UNSUPPORTED");
    }
    const { host, manifest } = createBackofficeCodemodeRemoteHost(providers, {
      step: stepTarget,
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
    } catch (error) {
      throw explainMcpCodemodeError(mcpDiscoveryError, error);
    } finally {
      host.close();
    }
  }
  const host = createCodemodeHost(providers, stepTarget);
  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    globalOutbound: globalOutbound ?? null,
  });
  const compiled = await resolveBackofficeWorkerCompiler(env)({
    files: {
      "remote-workflow.js": createCodemodeWorkflowSource({
        code,
        providerProxySource: createCodemodeProviderProxySource(providers),
      }),
    },
    entryPoint: "remote-workflow.js",
    dependencies: dependencies ?? {},
    runtime: { compatibilityDate: "2026-05-07", compatibilityFlags: ["nodejs_als"] },
  });
  let outcome:
    | { type: "completed"; output: WorkflowWorkerResult<TOutput> }
    | { type: "failed"; error: unknown };
  let suspension: Awaited<ReturnType<typeof host.settle>>;
  try {
    outcome = await executor
      .runEntrypoint<WorkflowWorkerEntrypoint<TParams, TOutput>, WorkflowWorkerResult<TOutput>>({
        bundle: compiled.bundle,
        rpcTargets: host.capabilities,
        run: (entrypoint, targets) =>
          entrypoint.run(
            { ...event, id: event.id ?? event.instanceId },
            targets.stepTarget as CodemodeStepCapability,
            targets.dispatchers as Record<string, unknown>,
          ),
      })
      .then(
        (output) => ({ type: "completed", output }) as const,
        (error: unknown) => ({ type: "failed", error }) as const,
      );
  } finally {
    host.close();
    suspension = await host.settle();
  }
  // Host retry and wake decisions survive even when their native RPC response is lost.
  if (suspension !== null) {
    throw new RemoteWorkflowSuspendedError(suspension);
  }
  if (outcome.type === "failed") {
    throw explainMcpCodemodeError(mcpDiscoveryError, outcome.error);
  }
  if (!outcome.output.ok) {
    throw new RemoteWorkflowSuspendedError(outcome.output.suspension.reason);
  }
  return outcome.output.result;
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
