import {
  createBackofficeCodemodeResolvedProviders,
  type BackofficeCodemodeExecuteResult,
} from "@/fragno/codemode/execute";
import type { JavaScriptModuleProgram } from "@/fragno/runtime-tools/families/javascript-runtime";
import type { BackofficeRuntimeToolFamily } from "@/fragno/runtime-tools/runtime-tools";
import type { CoreBackofficeToolContext } from "@/fragno/runtime-tools/tool-families";

import {
  codemodeProviderManifest,
  executeCodemodeInObject,
  type CodemodeRunner,
} from "./codemode-object-execute";
import { executeBackofficeCompiledModule } from "./compiled-module-execute";
import { explainMcpCodemodeError } from "./mcp-codemode-tools";

export type RunBackofficeJavaScriptModuleInput = {
  program: JavaScriptModuleProgram;
  codemode: CodemodeRunner;
  families: readonly BackofficeRuntimeToolFamily[];
  toolContext: CoreBackofficeToolContext;
};

/** Executes source or a compiled main module without invoking exports; startup failures are not rewritten. */
export async function runBackofficeJavaScriptModule({
  program,
  codemode,
  families,
  toolContext,
}: RunBackofficeJavaScriptModuleInput): Promise<BackofficeCodemodeExecuteResult> {
  const toolCalls: BackofficeCodemodeExecuteResult["toolCalls"] = [];
  const { providers, mcpDiscoveryError } = await createBackofficeCodemodeResolvedProviders({
    families,
    toolContext,
    toolCalls,
  });
  const origin = { kind: "file", path: program.path } as const;
  const completion =
    program.kind === "bundle"
      ? await executeBackofficeCompiledModule({
          bundle: program.bundle,
          invocation: null,
          input: null,
          providers,
          codemode,
          origin,
          signal: null,
        })
      : await executeCodemodeInObject(
          codemode,
          {
            kind: "module",
            code: program.code,
            dependencies: {},
            providers: codemodeProviderManifest(providers),
            timeoutMs: 30_000,
          },
          origin,
          providers,
          null,
        );
  return completion.status === "failed"
    ? {
        result: undefined,
        error: explainMcpCodemodeError(mcpDiscoveryError, completion.error.message),
        logs: completion.logs,
        toolCalls,
      }
    : { result: undefined, logs: completion.logs, toolCalls };
}
