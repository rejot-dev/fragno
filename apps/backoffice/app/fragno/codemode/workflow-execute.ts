import { CODEMODE_LIMITS } from "@fragno-dev/codemode/codemode-limits";
import { decodeCodemodeError } from "@fragno-dev/codemode/execution/codemode-errors";
import { createCodemodeHost } from "@fragno-dev/codemode/host/codemode-host-capabilities";
import {
  RemoteWorkflowSuspendedError,
  type RemoteWorkflowAllowedHook,
  type RemoteWorkflowStepHost,
} from "@fragno-dev/workflows/remote-workflow";
import type { RemoteWorkflowRunFn, WorkflowEvent } from "@fragno-dev/workflows/workflow";

import type { NpmDependencyMap } from "@/backoffice-runtime/dynamic-workers/npm-dependencies";
import { withBackofficeUiBuilder } from "@/backoffice-ui/builder";
import type {
  BackofficeRuntimeToolFamily,
  BackofficeToolContext,
} from "@/fragno/runtime-tools/runtime-tools";

import type { CodemodeRunOrigin } from "./codemode-fragment";
import { codemodeProviderManifest, type CodemodeRunner } from "./codemode-object-execute";
import { createBackofficeCodemodeResolvedProviders } from "./execute";
import { BackofficeWorkflowStepHost } from "./workflow-host";

export type BackofficeCodemodeWorkflowResult<TOutput = unknown> = {
  result?: TOutput;
  error?: string;
};
type CodemodeWorkflowEvent<TParams> = WorkflowEvent<TParams> & { id?: string };

export type BackofficeCodemodeWorkflowOptions = {
  families: readonly BackofficeRuntimeToolFamily[];
  toolContext: BackofficeToolContext;
  /** Hook identities the trusted host permits this sandbox to trigger. */
  allowedHooks: readonly RemoteWorkflowAllowedHook[];
  dependencies?: NpmDependencyMap;
  /** Saved modules the program imports, pinned when its instance was created. */
  modules: Record<string, string>;
  /** Names the program in each tick's run history. */
  origin: CodemodeRunOrigin;
};

type WorkflowExecutionInput<TParams> = {
  code: string;
  event: CodemodeWorkflowEvent<TParams>;
  remote: RemoteWorkflowStepHost;
  codemode: CodemodeRunner;
} & BackofficeCodemodeWorkflowOptions;

/** Runs one runner tick as a Codemode run; the step host stays here and only its capabilities travel. */
async function executeBackofficeCodemodeWorkflow<TParams, TOutput>(
  input: WorkflowExecutionInput<TParams>,
): Promise<TOutput> {
  const { modules, event, remote, codemode, origin, families, toolContext, dependencies } = input;
  const providers = createBackofficeCodemodeResolvedProviders({ families, toolContext });
  const host = createCodemodeHost(
    providers,
    new BackofficeWorkflowStepHost(remote, input.allowedHooks),
  );
  let completion;
  try {
    ({ completion } = await codemode.run(
      {
        kind: "workflow",
        code: withBackofficeUiBuilder(input.code),
        modules,
        dependencies: dependencies ?? {},
        providers: codemodeProviderManifest(providers),
        timeoutMs: CODEMODE_LIMITS.activationTimeoutMs,
        event: { ...event, id: event.id ?? event.instanceId },
      },
      origin,
      host,
    ));
  } finally {
    host.close();
  }
  if (completion.status === "suspended") {
    throw new RemoteWorkflowSuspendedError(completion.reason);
  }
  if (completion.status === "failed") {
    throw decodeCodemodeError(completion.error);
  }
  // Workflow output remains opaque until the runner's registered output schema validates it.
  return completion.value as TOutput;
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
  codemode: CodemodeRunner,
  options: BackofficeCodemodeWorkflowOptions,
): RemoteWorkflowRunFn<TParams, TOutput> {
  return async (event, remote) =>
    await executeBackofficeCodemodeWorkflow<TParams, TOutput>({
      code,
      event,
      remote,
      codemode,
      ...options,
    });
}
