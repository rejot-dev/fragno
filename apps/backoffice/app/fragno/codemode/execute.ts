import {
  compileWorker,
  type CompiledWorker,
  type WorkerCompiler,
} from "@/backoffice-runtime/dynamic-workers/compile-worker";
import type { NpmDependencyMap } from "@/backoffice-runtime/dynamic-workers/npm-dependencies";
import type { IFileSystem } from "@/files/interface";
import { createMcpCodemodeProviders } from "@/fragno/codemode/mcp-codemode-tools";
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
  DynamicWorkerExecutor,
  normalizeCode,
  resolveProvider,
  type ExecuteResult,
  type ResolvedProvider,
} from "./codemode-executor";
import { BackofficeStateFileSystem } from "./master-file-system-state";
import { BackofficeFileSystemStateBackend, stateToolsFromBackend } from "./state-backend";

export type BackofficeCodemodeEnv = {
  LOADER: WorkerLoader;
  /**
   * Outbound egress capability for workflow sandboxes (the `OutboundProxy`
   * service binding; see workers/app.ts). When present it is handed to the
   * dynamic worker as its `globalOutbound`, letting `fetch()` inside a workflow
   * step reach the internet. Absent (e.g. the Workers test pool) keeps the
   * sandbox sealed.
   */
  OUTBOUND?: Fetcher;
  compileWorker?: WorkerCompiler;
};

export type RunBackofficeCodemodeInput = {
  code: string;
  dependencies?: NpmDependencyMap;
  fs: IFileSystem;
  env: BackofficeCodemodeEnv;
  timeout?: number;
  families: readonly BackofficeRuntimeToolFamily[];
  toolContext: CoreBackofficeToolContext;
  /**
   * Outbound network policy for the codemode sandbox.
   * - `undefined` (default): grant egress via the host's `env.OUTBOUND`
   *   capability when bound, so `fetch()` reaches the internet; else sealed.
   * - a `Fetcher`: route every `fetch()` through a custom/allowlisting outbound.
   * - `null`: seal the sandbox (any `fetch()` throws the egress error).
   */
  globalOutbound?: Fetcher | null;
};

export type BackofficeCodemodeProvidersInput = {
  fs: IFileSystem;
  families: readonly BackofficeRuntimeToolFamily[];
  toolContext: CoreBackofficeToolContext;
  toolCalls?: BackofficeRuntimeToolCall[];
};

export type BackofficeCodemodeWorkflowDefinition = {
  name: string;
  options?: unknown;
};

export type BackofficeCodemodeExecuteResult = ExecuteResult & {
  toolCalls: BackofficeRuntimeToolCall[];
  workflowDefinition?: BackofficeCodemodeWorkflowDefinition;
};

export const normalizeBackofficeCodemodeCode = (code: string): string =>
  normalizeCode(code.trim().replace(/;*$/, "")).trim().replace(/;*$/, "");

type ScopedCodemodeCallInput = {
  scope:
    | { kind: "current" }
    | { kind: "org"; orgId: string }
    | { kind: "user"; userId: string }
    | { kind: "project"; orgId?: string; projectId: string };
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
    call.resultSummary = JSON.stringify(output);
    toolCalls?.push(call);
    return output;
  } catch (error) {
    call.status = "error";
    call.error = error instanceof Error ? error.message : String(error);
    toolCalls?.push(call);
    throw error;
  }
};

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
    callScoped: async (rawInput: unknown) => {
      const input = rawInput as ScopedCodemodeCallInput;
      const currentScope = context.execution.scope;
      const scope = input.scope.kind === "current" ? currentScope : input.scope;
      if (scope.kind === "project" && !scope.orgId) {
        if (currentScope.kind !== "org" && currentScope.kind !== "project") {
          throw new Error("Project scoped codemode handles require a current org context.");
        }
        return await callScopedTool(
          input,
          context.createScopedContext({ ...scope, orgId: currentScope.orgId }),
          families,
          toolCalls,
        );
      }

      if (scope.kind === "project") {
        const orgId = scope.orgId;
        if (!orgId) {
          throw new Error("Project scoped codemode handles require an org id.");
        }
        return await callScopedTool(
          input,
          context.createScopedContext({
            kind: "project",
            orgId,
            projectId: scope.projectId,
          }),
          families,
          toolCalls,
        );
      }

      return await callScopedTool(input, context.createScopedContext(scope), families, toolCalls);
    },
  },
});

export const createBackofficeCodemodeResolvedProviders = async ({
  fs,
  families,
  toolContext,
  toolCalls,
}: BackofficeCodemodeProvidersInput): Promise<ResolvedProvider[]> => {
  const providers: ResolvedProvider[] = [];

  const stateBackend = new BackofficeFileSystemStateBackend(new BackofficeStateFileSystem(fs));
  providers.push(resolveProvider(stateToolsFromBackend(stateBackend)));

  const tools = families.flatMap((family) => {
    if (family.isAvailable && !family.isAvailable(toolContext)) {
      return [];
    }
    return [...family.tools];
  });

  providers.push(
    ...createBackofficeCodemodeProviders({ tools, context: toolContext, toolCalls }).map(
      (provider) => resolveProvider(provider),
    ),
  );

  providers.push(
    resolveProvider(
      createBackofficeScopedCodemodeProvider({ families, context: toolContext, toolCalls }),
    ),
  );

  if (toolContext.runtimes.mcp) {
    providers.push(
      ...(
        await createMcpCodemodeProviders({
          runtime: toolContext.runtimes.mcp,
          context: toolContext,
          toolCalls,
        })
      ).map((provider) => resolveProvider(provider)),
    );
  }

  return providers;
};

export const runBackofficeCodemode = async ({
  code,
  dependencies,
  fs,
  env,
  timeout,
  families,
  toolContext,
  globalOutbound,
}: RunBackofficeCodemodeInput): Promise<BackofficeCodemodeExecuteResult> => {
  const toolCalls: BackofficeRuntimeToolCall[] = [];

  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    timeout,
    // Default (caller passed nothing): grant egress via the host's OUTBOUND
    // capability when bound, else stay sealed. An explicit Fetcher or `null` wins.
    globalOutbound: globalOutbound === undefined ? (env.OUTBOUND ?? null) : globalOutbound,
  });

  const providers = await createBackofficeCodemodeResolvedProviders({
    fs,
    families,
    toolContext,
    toolCalls,
  });

  const compile = env.compileWorker ?? compileWorker;
  let compiled: CompiledWorker;
  try {
    compiled = await compile({
      files: {
        "executor.js": executor.createExecutorModule(
          normalizeBackofficeCodemodeCode(code),
          providers,
        ),
      },
      entryPoint: "executor.js",
      dependencies,
      runtime: {
        compatibilityDate: "2026-05-07",
        compatibilityFlags: ["nodejs_compat"],
      },
    });
  } catch (error) {
    return {
      result: undefined,
      error: `Failed to compile codemode: ${error instanceof Error ? error.message : String(error)}`,
      toolCalls,
    };
  }

  const result = (await executor.execute(
    compiled.bundle,
    providers,
  )) as BackofficeCodemodeExecuteResult;
  return {
    ...result,
    logs: [...compiled.warnings, ...(result.logs ?? [])],
    toolCalls,
  };
};
