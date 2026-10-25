import { CODEMODE_LIMITS } from "@fragno-dev/codemode/codemode-limits";
import { decodeCodemodeError } from "@fragno-dev/codemode/execution/codemode-errors";
import {
  RemoteWorkflowSuspendedError,
  type RemoteWorkflowAllowedHook,
  type RemoteWorkflowStepHost,
} from "@fragno-dev/workflows/remote-workflow";
import type { RemoteWorkflowRunFn, WorkflowEvent } from "@fragno-dev/workflows/workflow";
import { withBackofficeUiBuilderModule } from "@fragno-private/backoffice-ui/builder";

import type { NpmDependencyMap } from "@/backoffice-runtime/dynamic-workers/npm-dependencies";
import type {
  BackofficeRuntimeToolFamily,
  BackofficeToolContext,
} from "@/fragno/runtime-tools/runtime-tools";

import type {
  CodemodeRunActivation,
  CodemodeRunCompletion,
  CodemodeRunOrigin,
} from "./codemode-fragment";
import {
  codemodeProviderManifest,
  createCodemodeRunHost,
  type CodemodeRunner,
} from "./codemode-object-execute";
import { createBackofficeCodemodeRunTools } from "./execute";
import { BackofficeWorkflowStepHost } from "./workflow-host";
import type { CodemodeWorkflowProgram } from "./workflow-program";

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
  /** Names the program in each tick's run history. */
  origin: CodemodeRunOrigin;
};

type WorkflowTickCompletion = CodemodeRunCompletion<
  Extract<CodemodeRunActivation, { kind: "workflow" }>
>;

type WorkflowExecutionInput<TParams> = {
  program: Pick<CodemodeWorkflowProgram, "filename" | "modules">;
  event: CodemodeWorkflowEvent<TParams>;
  remote: RemoteWorkflowStepHost;
  codemode: CodemodeRunner;
} & BackofficeCodemodeWorkflowOptions;

/** Runs one runner tick as a Codemode run; the step host stays here and only its capabilities travel. */
async function runCodemodeWorkflowTick<TParams>(
  input: WorkflowExecutionInput<TParams>,
): Promise<WorkflowTickCompletion> {
  const { program, event, remote, codemode, origin, families, toolContext, dependencies } = input;
  const tools = createBackofficeCodemodeRunTools({ families, toolContext, toolCallLog: null });
  const runHost = createCodemodeRunHost(
    tools,
    new BackofficeWorkflowStepHost(remote, input.allowedHooks),
  );
  let completion;
  try {
    ({ completion } = await codemode.run(
      {
        kind: "workflow",
        ...withBackofficeUiBuilderModule({ entry: program.filename, modules: program.modules }),
        dependencies: dependencies ?? {},
        providers: codemodeProviderManifest(tools.providers),
        timeoutMs: CODEMODE_LIMITS.activationTimeoutMs,
        event: { ...event, id: event.id ?? event.instanceId },
      },
      origin,
      runHost,
    ));
  } finally {
    await runHost.host.close();
  }
  return completion;
}

/** Hands a tick's completion to the runner: its output, or a suspension, interruption, or guest error. */
function workflowTickOutput(
  completion: WorkflowTickCompletion,
  remote: RemoteWorkflowStepHost,
): unknown {
  if (completion.status === "suspended") {
    throw new RemoteWorkflowSuspendedError(completion.reason);
  }
  if (completion.status === "interrupted") {
    // Without an outcome from the bridge the tick may not have run, so the runner tries it again.
    return remote.interruptTick(completion.cause);
  }
  if (completion.status === "failed") {
    throw decodeCodemodeError(completion.error);
  }
  return completion.value;
}

/** Runs one activation; guest errors become the result, while suspensions and interruptions reach the runner. */
export async function runBackofficeCodemodeWorkflow<TParams = unknown, TOutput = unknown>(
  input: WorkflowExecutionInput<TParams>,
): Promise<BackofficeCodemodeWorkflowResult<TOutput>> {
  let completion;
  try {
    completion = await runCodemodeWorkflowTick(input);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (completion.status === "failed") {
    return { error: decodeCodemodeError(completion.error).message };
  }
  // Workflow output remains opaque until the runner's registered output schema validates it.
  return { result: workflowTickOutput(completion, input.remote) as TOutput };
}

/** Re-evaluates the workflow program on each runner tick using Node-owned checkpoints. */
export function defineCodemodeWorkflowRun<TParams = unknown, TOutput = unknown>(
  program: Pick<CodemodeWorkflowProgram, "filename" | "modules">,
  codemode: CodemodeRunner,
  options: BackofficeCodemodeWorkflowOptions,
): RemoteWorkflowRunFn<TParams, TOutput> {
  return async (event, remote) =>
    workflowTickOutput(
      await runCodemodeWorkflowTick({ program, event, remote, codemode, ...options }),
      remote,
    ) as TOutput;
}
