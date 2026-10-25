import { createBackofficeCodemodeRunTools } from "@/fragno/codemode/execute";
import type {
  JavaScriptModuleExecution,
  JavaScriptModuleProgram,
} from "@/fragno/runtime-tools/families/javascript-runtime";
import type { BackofficeRuntimeToolFamily } from "@/fragno/runtime-tools/runtime-tools";
import type { CoreBackofficeToolContext } from "@/fragno/runtime-tools/tool-families";

import {
  codemodeProviderManifest,
  executeCodemodeInObject,
  type CodemodeRunner,
} from "./codemode-object-execute";
import { executeBackofficeCompiledModule } from "./compiled-module-execute";

export type RunBackofficeJavaScriptModuleInput = {
  program: JavaScriptModuleProgram;
  codemode: CodemodeRunner;
  families: readonly BackofficeRuntimeToolFamily[];
  toolContext: CoreBackofficeToolContext;
};

/** Executes source or a compiled main module without invoking exports. */
export async function runBackofficeJavaScriptModule({
  program,
  codemode,
  families,
  toolContext,
}: RunBackofficeJavaScriptModuleInput): Promise<JavaScriptModuleExecution> {
  const tools = createBackofficeCodemodeRunTools({ families, toolContext, toolCallLog: null });
  const origin = { kind: "file", path: program.path } as const;
  const { runId, completion } =
    program.kind === "bundle"
      ? await executeBackofficeCompiledModule({
          bundle: program.bundle,
          invocation: null,
          input: null,
          tools,
          codemode,
          origin,
          signal: null,
        })
      : await executeCodemodeInObject(
          codemode,
          {
            kind: "module",
            entry: program.path,
            modules: program.modules,
            dependencies: {},
            providers: codemodeProviderManifest(tools.providers),
            timeoutMs: 30_000,
          },
          origin,
          tools,
          null,
        );
  return completion.status === "failed"
    ? {
        status: "error",
        runId,
        error: completion.error.message,
        logs: completion.logs,
      }
    : { status: "success", runId, logs: completion.logs };
}
