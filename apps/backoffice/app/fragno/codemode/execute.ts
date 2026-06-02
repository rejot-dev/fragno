import { stateToolsFromBackend } from "@cloudflare/shell/workers";

import { DynamicWorkerExecutor, resolveProvider, type ExecuteResult } from "@cloudflare/codemode";
import { FileSystemStateBackend } from "@cloudflare/shell";

import type { IFileSystem } from "@/files/interface";

import { BackofficeStateFileSystem } from "./master-file-system-state";

export type BackofficeCodemodeEnv = {
  LOADER: WorkerLoader;
};

export type RunBackofficeCodemodeInput = {
  code: string;
  fs: IFileSystem;
  env: BackofficeCodemodeEnv;
  timeout?: number;
};

export type BackofficeCodemodeResult = ExecuteResult;

export const runBackofficeCodemode = async ({
  code,
  fs,
  env,
  timeout,
}: RunBackofficeCodemodeInput): Promise<BackofficeCodemodeResult> => {
  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    timeout,
    globalOutbound: null,
  });

  const stateBackend = new FileSystemStateBackend(new BackofficeStateFileSystem(fs));
  const providers = [resolveProvider(stateToolsFromBackend(stateBackend))];

  return executor.execute(code, providers);
};
