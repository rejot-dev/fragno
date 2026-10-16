import {
  type BackofficeContextScope,
  backofficeScopeProjectOwner,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { WorkerCompiler } from "@fragno-dev/codemode/compiler/compile-worker";
import { createWorkerCompilerServiceClient } from "@fragno-dev/codemode/compiler/compiler-service-client";
import type { CodemodeRemoteExecutor } from "@fragno-dev/codemode/execution/codemode-activation-contract";
import {
  resolveProvider,
  type ExecuteResult,
  type ResolvedProvider,
} from "@fragno-dev/codemode/runtime-api";

import type { NpmDependencyMap } from "@/backoffice-runtime/dynamic-workers/npm-dependencies";
import { withBackofficeUiBuilder } from "@/backoffice-ui/builder";
import {
  createBackofficeCodemodeProviders,
  executeBackofficeRuntimeTool,
} from "@/fragno/runtime-tools/runtime-tools";
import type {
  BackofficeRuntimeToolCall,
  BackofficeRuntimeToolFamily,
  BackofficeToolContext,
} from "@/fragno/runtime-tools/runtime-tools";
import type { CoreBackofficeToolContext } from "@/fragno/runtime-tools/tool-families";

import {
  codemodeProviderManifest,
  executeCodemodeInObject,
  type CodemodeRunner,
} from "./codemode-object-execute";
import { readSavedModuleImports } from "./saved-module-imports";

export type BackofficeCodemodeEnv =
  | LocalBackofficeCodemodeEnv
  | { remoteExecutor: CodemodeRemoteExecutor };

/** Guests have no network egress; internet access goes through authorized `web.*` tools. */
export type LocalBackofficeCodemodeEnv = {
  LOADER: WorkerLoader;
  CODEMODE_COMPILER?: Fetcher;
  compileWorker?: WorkerCompiler;
};

export type RunBackofficeCodemodeInput = {
  code: string;
  dependencies?: NpmDependencyMap;
  codemode: CodemodeRunner;
  timeout?: number;
  families: readonly BackofficeRuntimeToolFamily[];
  toolContext: CoreBackofficeToolContext;
};

export type BackofficeCodemodeProvidersInput = {
  families: readonly BackofficeRuntimeToolFamily[];
  toolContext: CoreBackofficeToolContext;
  toolCalls?: BackofficeRuntimeToolCall[];
};

export type BackofficeCodemodeWorkflowDefinition = {
  name: string;
  options?: unknown;
};

export type BackofficeCodemodeExecuteResult = ExecuteResult & {
  /** Leads to the run's retained record and its `codemode` events. */
  runId: string;
  toolCalls: BackofficeRuntimeToolCall[];
  workflowDefinition?: BackofficeCodemodeWorkflowDefinition;
  /** Saved modules the code imported; a workflow it defines pins these when scheduled. */
  modules: Record<string, string>;
};

type ScopedCodemodeCallInput = {
  scope:
    | { kind: "current" }
    | { kind: "org"; orgId: string }
    | { kind: "user"; userId: string }
    // The guest names only the project; its owner is the current scope's organization.
    | { kind: "project"; projectId: string };
  namespace: string;
  toolName: string;
  args: unknown[];
};

const callScopedTool = async (
  input: ScopedCodemodeCallInput,
  scopedContext: BackofficeToolContext,
  families: readonly BackofficeRuntimeToolFamily[],
  toolCalls?: BackofficeRuntimeToolCall[],
) => {
  const tool = families
    .flatMap((family) => {
      if (family.isAvailable && !family.isAvailable(scopedContext)) {
        return [];
      }
      return [...family.tools];
    })
    .find(
      (candidate) => candidate.namespace === input.namespace && candidate.name === input.toolName,
    );
  if (!tool) {
    throw new Error(`Unknown scoped tool: ${input.namespace}.${input.toolName}`);
  }

  const call: BackofficeRuntimeToolCall = {
    providerName: `${input.scope.kind}:${input.namespace}`,
    toolName: input.toolName,
    toolId: tool.id,
    inputSummary: JSON.stringify(input.args[0] ?? null),
    status: "success",
  };
  try {
    const output = await executeBackofficeRuntimeTool(tool, input.args[0], scopedContext);
    call.resultSummary = tool.resultLogging === "redacted" ? "[redacted]" : JSON.stringify(output);
    toolCalls?.push(call);
    return output;
  } catch (error) {
    call.status = "error";
    call.error = error instanceof Error ? error.message : String(error);
    toolCalls?.push(call);
    throw error;
  }
};

function codemodeCallScope(
  requested: ScopedCodemodeCallInput["scope"],
  current: BackofficeContextScope,
): BackofficeContextScope {
  switch (requested.kind) {
    case "current":
      return current;
    // A project handle names a project beside the current workspace.
    case "project": {
      const owner = backofficeScopeProjectOwner(current);
      if (!owner) {
        throw new Error("Project scoped codemode handles require a workspace that owns projects.");
      }
      return { kind: "project", owner, projectId: requested.projectId };
    }
    case "org":
    case "user":
      return requested;
    default:
      throw new Error("Unsupported codemode scope kind.", { cause: requested satisfies never });
  }
}

const createBackofficeScopedCodemodeProvider = ({
  families,
  context,
  toolCalls,
}: {
  families: readonly BackofficeRuntimeToolFamily[];
  context: BackofficeToolContext;
  toolCalls?: BackofficeRuntimeToolCall[];
}) => ({
  name: "__context",
  fns: {
    getCurrentScope: async () => context.execution.scope,
    callScoped: async (rawInput: unknown) => {
      const input = rawInput as ScopedCodemodeCallInput;
      const scope = codemodeCallScope(input.scope, context.execution.scope);
      return await callScopedTool(input, context.createScopedContext(scope), families, toolCalls);
    },
  },
});

export function createBackofficeCodemodeResolvedProviders({
  families,
  toolContext,
  toolCalls,
}: BackofficeCodemodeProvidersInput): ResolvedProvider[] {
  const tools = families.flatMap((family) => {
    if (family.isAvailable && !family.isAvailable(toolContext)) {
      return [];
    }
    return [...family.tools];
  });

  return [
    ...createBackofficeCodemodeProviders({ tools, context: toolContext, toolCalls }),
    createBackofficeScopedCodemodeProvider({ families, context: toolContext, toolCalls }),
  ].map((provider) => resolveProvider(provider));
}

/** Resolves the in-process test compiler or private production compiler service. */
export function resolveBackofficeWorkerCompiler(env: LocalBackofficeCodemodeEnv): WorkerCompiler {
  if (env.compileWorker) {
    return env.compileWorker;
  }
  if (env.CODEMODE_COMPILER) {
    return createWorkerCompilerServiceClient(env.CODEMODE_COMPILER);
  }
  throw new Error("Backoffice codemode compiler service is not configured.");
}

export const runBackofficeCodemode = async ({
  code,
  dependencies,
  codemode,
  timeout,
  families,
  toolContext,
}: RunBackofficeCodemodeInput): Promise<BackofficeCodemodeExecuteResult> => {
  const toolCalls: BackofficeRuntimeToolCall[] = [];

  const state = toolContext.runtimes.state;
  // Without a filesystem, saved-module imports stay unresolved and fail when the code runs.
  const { modules } = state
    ? await readSavedModuleImports({
        readFile: (path) => state.readFile(path),
        program: { kind: "inline", code },
      })
    : { modules: {} };
  const providers = createBackofficeCodemodeResolvedProviders({ families, toolContext, toolCalls });
  const { runId, completion } = await executeCodemodeInObject(
    codemode,
    {
      kind: "immediate",
      code: withBackofficeUiBuilder(code),
      modules,
      dependencies: dependencies ?? {},
      providers: codemodeProviderManifest(providers),
      timeoutMs: timeout ?? 30_000,
    },
    { kind: "inline" },
    providers,
    null,
  );
  if (completion.status === "failed") {
    return {
      runId,
      result: undefined,
      error: completion.error.message,
      logs: completion.logs,
      toolCalls,
      modules,
    };
  }
  return {
    runId,
    result: completion.value,
    logs: completion.logs,
    ...(completion.workflowDefinition ? { workflowDefinition: completion.workflowDefinition } : {}),
    toolCalls,
    modules,
  };
};
