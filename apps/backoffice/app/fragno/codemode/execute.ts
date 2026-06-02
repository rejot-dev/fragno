import { stateToolsFromBackend } from "@cloudflare/shell/workers";

import { DynamicWorkerExecutor, resolveProvider, type ExecuteResult } from "@cloudflare/codemode";
import { FileSystemStateBackend } from "@cloudflare/shell";

import type { IFileSystem } from "@/files/interface";
import { createBackofficeCodemodeProviders } from "@/fragno/runtime-tools/runtime-tools";
import type {
  AnyBackofficeRuntimeTool,
  BackofficeToolContext,
} from "@/fragno/runtime-tools/runtime-tools";

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

export type BackofficeCodemodeResult = ExecuteResult;

export const runBackofficeCodemode = async ({
  code,
  fs,
  env,
  timeout,
  tools = [],
  context = { runtimes: {} },
}: RunBackofficeCodemodeInput): Promise<BackofficeCodemodeResult> => {
  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    timeout,
    globalOutbound: null,
  });

  const stateBackend = new FileSystemStateBackend(new BackofficeStateFileSystem(fs));
  const providers = [
    resolveProvider(stateToolsFromBackend(stateBackend)),
    ...createBackofficeCodemodeProviders({ tools, context }).map((provider) =>
      resolveProvider(provider),
    ),
  ];

  return executor.execute(code, providers);
};
