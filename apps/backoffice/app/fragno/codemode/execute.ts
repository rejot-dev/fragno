import { stateToolsFromBackend } from "@cloudflare/shell/workers";

import { FileSystemStateBackend } from "@cloudflare/shell";

import type { IFileSystem } from "@/files/interface";
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
  options?: unknown;
};

export type BackofficeCodemodeExecuteResult = ExecuteResult & {
  toolCalls: BackofficeRuntimeToolCall[];
  workflowDefinition?: BackofficeCodemodeWorkflowDefinition;
};

export const normalizeBackofficeCodemodeCode = (code: string): string =>
  normalizeCode(code.trim().replace(/;*$/, "")).trim().replace(/;*$/, "");

export const createBackofficeCodemodeResolvedProviders = ({
  fs,
  tools = [],
  context = { runtimes: {} },
  toolCalls,
}: BackofficeCodemodeProvidersInput): ResolvedProvider[] => {
  const providers: ResolvedProvider[] = [];

  if (fs) {
    const stateBackend = new FileSystemStateBackend(new BackofficeStateFileSystem(fs));
    providers.push(resolveProvider(stateToolsFromBackend(stateBackend)));
  }

  providers.push(
    ...createBackofficeCodemodeProviders({ tools, context, toolCalls }).map((provider) =>
      resolveProvider(provider),
    ),
  );

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
  const providers = createBackofficeCodemodeResolvedProviders({ fs, tools, context, toolCalls });

  const result = (await executor.execute(
    normalizeBackofficeCodemodeCode(code),
    providers,
  )) as BackofficeCodemodeExecuteResult;
  return { ...result, toolCalls };
};
