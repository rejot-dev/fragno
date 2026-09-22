import type { CompiledWorker } from "@/backoffice-runtime/dynamic-workers/compile-worker";
import {
  createBackofficeCodemodeResolvedProviders,
  resolveBackofficeWorkerCompiler,
  type BackofficeCodemodeEnv,
  type BackofficeCodemodeExecuteResult,
} from "@/fragno/codemode/execute";
import type { BackofficeRuntimeToolFamily } from "@/fragno/runtime-tools/runtime-tools";
import type { CoreBackofficeToolContext } from "@/fragno/runtime-tools/tool-families";

import { DynamicWorkerExecutor } from "./codemode-executor";

export type RunBackofficeJavaScriptModuleInput = {
  code: string;
  env: BackofficeCodemodeEnv;
  timeout?: number;
  families: readonly BackofficeRuntimeToolFamily[];
  toolContext: CoreBackofficeToolContext;
  globalOutbound?: Fetcher | null;
};

/** Executes a JavaScript file as an ES module without invoking any exported value. */
export async function runBackofficeJavaScriptModule({
  code,
  env,
  timeout,
  families,
  toolContext,
  globalOutbound,
}: RunBackofficeJavaScriptModuleInput): Promise<BackofficeCodemodeExecuteResult> {
  const toolCalls: BackofficeCodemodeExecuteResult["toolCalls"] = [];
  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    timeout,
    globalOutbound: globalOutbound === undefined ? (env.OUTBOUND ?? null) : globalOutbound,
  });
  const providers = await createBackofficeCodemodeResolvedProviders({
    families,
    toolContext,
    toolCalls,
  });

  let compiled: CompiledWorker;
  try {
    compiled = await resolveBackofficeWorkerCompiler(env)({
      files: {
        "executor.js": executor.createJavaScriptModuleExecutorModule("./script.js", providers),
        "script.js": code,
      },
      entryPoint: "executor.js",
      dependencies: {},
      runtime: {
        compatibilityDate: "2026-05-07",
        compatibilityFlags: ["nodejs_compat"],
      },
    });
  } catch (error) {
    return {
      result: undefined,
      error: `Failed to compile JavaScript file: ${error instanceof Error ? error.message : String(error)}`,
      logs: [],
      toolCalls,
    };
  }

  const result = await executor.execute(compiled.bundle, providers);
  return {
    ...result,
    logs: [...compiled.warnings, ...(result.logs ?? [])],
    toolCalls,
  };
}
