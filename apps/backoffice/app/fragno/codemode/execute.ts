import { stateToolsFromBackend } from "@cloudflare/shell/workers";

import { DynamicWorkerExecutor, resolveProvider, type ExecuteResult } from "@cloudflare/codemode";
import { FileSystemStateBackend } from "@cloudflare/shell";

import type { IFileSystem } from "@/files/interface";
import { createBackofficeCodemodeProviders } from "@/fragno/runtime-tools/runtime-tools";
import type {
  AnyBackofficeRuntimeTool,
  BackofficeRuntimeToolCall,
  BackofficeToolContext,
} from "@/fragno/runtime-tools/runtime-tools";

import { BackofficeStateFileSystem } from "./master-file-system-state";

export type BackofficeCodemodeEnv = {
  LOADER: WorkerLoader;
};

export type RunBackofficeCodemodeInput<
  TContext extends BackofficeToolContext = BackofficeToolContext,
> = {
  code: string;
  fs: IFileSystem;
  env: BackofficeCodemodeEnv;
  timeout?: number;
  tools?: readonly AnyBackofficeRuntimeTool<TContext>[];
  context?: TContext;
};

export type BackofficeCodemodeExecuteResult = ExecuteResult & {
  toolCalls: BackofficeRuntimeToolCall[];
};

export const runBackofficeCodemode = async <
  TContext extends BackofficeToolContext = BackofficeToolContext,
>({
  code,
  fs,
  env,
  timeout,
  tools = [],
  context = { runtimes: {} } as TContext,
}: RunBackofficeCodemodeInput<TContext>): Promise<BackofficeCodemodeExecuteResult> => {
  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    timeout,
    globalOutbound: null,
  });

  const stateBackend = new FileSystemStateBackend(new BackofficeStateFileSystem(fs));
  const toolCalls: BackofficeRuntimeToolCall[] = [];
  const providers = [
    resolveProvider(stateToolsFromBackend(stateBackend)),
    ...createBackofficeCodemodeProviders({ tools, context, toolCalls }).map((provider) =>
      resolveProvider(provider),
    ),
  ];

  const result = await executor.execute(code, providers);
  return { ...result, toolCalls };
};
