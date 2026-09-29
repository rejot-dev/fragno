import type { CompiledWorker } from "@fragno-dev/codemode/compiler/compile-worker";
import { DynamicWorkerExecutor } from "@fragno-dev/codemode/worker/codemode-executor";
import { createCodemodeModuleSource } from "@fragno-dev/codemode/worker/codemode-guest-source";

import {
  createBackofficeCodemodeResolvedProviders,
  resolveBackofficeWorkerCompiler,
  type BackofficeCodemodeEnv,
  type BackofficeCodemodeExecuteResult,
} from "@/fragno/codemode/execute";
import type { BackofficeRuntimeToolFamily } from "@/fragno/runtime-tools/runtime-tools";
import type { CoreBackofficeToolContext } from "@/fragno/runtime-tools/tool-families";

import { runBackofficeRemoteImmediate } from "./remote-immediate-execute";

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
  const providers = await createBackofficeCodemodeResolvedProviders({
    families,
    toolContext,
    toolCalls,
  });
  if ("remoteExecutor" in env) {
    if (globalOutbound) {
      throw new Error("CODEMODE_REMOTE_EGRESS_UNSUPPORTED");
    }
    return {
      ...(await runBackofficeRemoteImmediate({
        execute: env.remoteExecutor,
        kind: "module",
        code,
        dependencies: {},
        timeout,
        providers,
      })),
      toolCalls,
    };
  }
  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    globalOutbound: globalOutbound === undefined ? (env.OUTBOUND ?? null) : globalOutbound,
  });

  let compiled: CompiledWorker;
  try {
    compiled = await resolveBackofficeWorkerCompiler(env)({
      files: {
        "executor.js": createCodemodeModuleSource("./script.js", providers, timeout),
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
