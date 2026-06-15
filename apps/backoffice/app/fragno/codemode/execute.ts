import type { IFileSystem } from "@/files/interface";
import { createMcpCodemodeProviders } from "@/fragno/codemode/mcp-codemode-tools";
import type { McpRuntime } from "@/fragno/runtime-tools/families/mcp-runtime";
import { createBackofficeCodemodeProviders } from "@/fragno/runtime-tools/runtime-tools";
import type {
  AnyBackofficeRuntimeTool,
  BackofficeRuntimeToolCall,
  BackofficeToolContext,
} from "@/fragno/runtime-tools/runtime-tools";

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
  tools?: readonly AnyBackofficeRuntimeTool[];
  context?: BackofficeToolContext;
};

export type BackofficeCodemodeProvidersInput = {
  fs?: IFileSystem;
  tools?: readonly AnyBackofficeRuntimeTool[];
  context?: BackofficeToolContext;
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

export const createBackofficeCodemodeResolvedProviders = async ({
  fs,
  tools = [],
  context = { runtimes: {} },
  toolCalls,
}: BackofficeCodemodeProvidersInput): Promise<ResolvedProvider[]> => {
  const providers: ResolvedProvider[] = [];

  if (fs) {
    const stateBackend = new BackofficeFileSystemStateBackend(new BackofficeStateFileSystem(fs));
    providers.push(resolveProvider(stateToolsFromBackend(stateBackend)));
  }

  providers.push(
    ...createBackofficeCodemodeProviders({ tools, context, toolCalls }).map((provider) =>
      resolveProvider(provider),
    ),
  );

  if (context.runtimes.mcp) {
    providers.push(
      ...(
        await createMcpCodemodeProviders({
          runtime: context.runtimes.mcp as McpRuntime,
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
  tools = [],
  context = { runtimes: {} },
}: RunBackofficeCodemodeInput): Promise<BackofficeCodemodeExecuteResult> => {
  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    timeout,
    globalOutbound: null,
  });

  const toolCalls: BackofficeRuntimeToolCall[] = [];
  const providers = await createBackofficeCodemodeResolvedProviders({
    fs,
    tools,
    context,
    toolCalls,
  });

  const result = (await executor.execute(
    normalizeBackofficeCodemodeCode(code),
    providers,
  )) as BackofficeCodemodeExecuteResult;
  return { ...result, toolCalls };
};
