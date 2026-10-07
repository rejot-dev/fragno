import type { CompiledWorker } from "@fragno-dev/codemode/compiler/compile-worker";
import { createCodemodeModuleSource } from "@fragno-dev/codemode/guest/codemode-module-source";
import { DynamicWorkerExecutor } from "@fragno-dev/codemode/guest/codemode-worker-executor";

import {
  createBackofficeCodemodeResolvedProviders,
  resolveBackofficeWorkerCompiler,
  type BackofficeCodemodeEnv,
  type BackofficeCodemodeExecuteResult,
} from "@/fragno/codemode/execute";
import type { JavaScriptModuleProgram } from "@/fragno/runtime-tools/families/javascript-runtime";
import type { BackofficeRuntimeToolFamily } from "@/fragno/runtime-tools/runtime-tools";
import type { CoreBackofficeToolContext } from "@/fragno/runtime-tools/tool-families";

import { executeBackofficeCompiledModule } from "./compiled-module-execute";
import { explainMcpCodemodeError } from "./mcp-codemode-tools";
import { runBackofficeRemoteImmediate } from "./remote-immediate-execute";

export type RunBackofficeJavaScriptModuleInput = {
  program: JavaScriptModuleProgram;
  env: BackofficeCodemodeEnv;
  timeout?: number;
  families: readonly BackofficeRuntimeToolFamily[];
  toolContext: CoreBackofficeToolContext;
  globalOutbound?: Fetcher | null;
};

/** Executes source or a compiled main module without invoking exports; startup failures are not rewritten. */
export async function runBackofficeJavaScriptModule({
  program,
  env,
  timeout,
  families,
  toolContext,
  globalOutbound,
}: RunBackofficeJavaScriptModuleInput): Promise<BackofficeCodemodeExecuteResult> {
  const toolCalls: BackofficeCodemodeExecuteResult["toolCalls"] = [];
  const { providers, mcpDiscoveryError } = await createBackofficeCodemodeResolvedProviders({
    families,
    toolContext,
    toolCalls,
  });
  if (program.kind === "bundle") {
    const completion = await executeBackofficeCompiledModule({
      bundle: program.bundle,
      invocation: null,
      input: null,
      providers,
      env,
      signal: null,
    });
    if (completion.status === "suspended") {
      throw new Error("CODEMODE_MODULE_INVOCATION_CANNOT_SUSPEND");
    }
    return completion.status === "failed"
      ? {
          result: undefined,
          error: explainMcpCodemodeError(mcpDiscoveryError, completion.error.message),
          logs: completion.logs,
          toolCalls,
        }
      : { result: undefined, logs: completion.logs, toolCalls };
  }
  const { code } = program;
  if ("remoteExecutor" in env) {
    if (globalOutbound) {
      throw new Error("CODEMODE_REMOTE_EGRESS_UNSUPPORTED");
    }
    const result = await runBackofficeRemoteImmediate({
      execute: env.remoteExecutor,
      kind: "module",
      code,
      dependencies: {},
      timeout,
      providers,
    });
    return {
      ...result,
      ...(result.error ? { error: explainMcpCodemodeError(mcpDiscoveryError, result.error) } : {}),
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
    ...(result.error ? { error: explainMcpCodemodeError(mcpDiscoveryError, result.error) } : {}),
    logs: [...compiled.warnings, ...(result.logs ?? [])],
    toolCalls,
  };
}
