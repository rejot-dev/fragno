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
};

export type RunBackofficeCodemodeInput = {
  code: string;
  fs: IFileSystem;
  env: BackofficeCodemodeEnv;
  timeout?: number;
  families: readonly BackofficeRuntimeToolFamily[];
  toolContext: CoreBackofficeToolContext;
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
    | { kind: "project"; projectId: string };
  namespace: string;
  toolName: string;
  args: unknown[];
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
      const scope = input.scope.kind === "current" ? context.scope : input.scope;
      const scopedContext = context.createScopedContext(scope);
      const tool = families
        .flatMap((family) => {
          if (family.isAvailable && !family.isAvailable(scopedContext)) {
            return [];
          }
          return [...family.tools];
        })
        .find(
          (candidate) =>
            candidate.namespace === input.namespace && candidate.name === input.toolName,
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
  fs,
  env,
  timeout,
  families,
  toolContext,
}: RunBackofficeCodemodeInput): Promise<BackofficeCodemodeExecuteResult> => {
  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    timeout,
    globalOutbound: null,
  });

  const toolCalls: BackofficeRuntimeToolCall[] = [];
  const providers = await createBackofficeCodemodeResolvedProviders({
    fs,
    families,
    toolContext,
    toolCalls,
  });

  const result = (await executor.execute(
    normalizeBackofficeCodemodeCode(code),
    providers,
  )) as BackofficeCodemodeExecuteResult;
  return { ...result, toolCalls };
};
