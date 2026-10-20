import type { CompiledWorker } from "@fragno-dev/codemode/compiler/compile-worker";
import type { WorkerBundle } from "@fragno-dev/codemode/compiler/worker-bundle";
import { decodeCodemodeError } from "@fragno-dev/codemode/execution/codemode-errors";
import { codemodeWorkerBundleSchema } from "@fragno-dev/codemode/execution/codemode-worker-bundle";
import type { ResolvedProvider } from "@fragno-dev/codemode/runtime-api";
import { z } from "zod";

import type {
  CodemodeExecution,
  CodemodeRunActivation,
  CodemodeRunOrigin,
} from "./codemode-fragment";
import {
  codemodeProviderManifest,
  executeCodemodeInObject,
  type CodemodeRunner,
} from "./codemode-object-execute";

/** Bundles an ES module without executing it or choosing a consumer-specific entrypoint. */
export async function buildBackofficeJavaScriptModule(input: {
  entry: string;
  modules: Record<string, string>;
  dependencies: Record<string, string>;
  codemode: CodemodeRunner;
}): Promise<
  | ({ status: "success"; runId: string } & CompiledWorker)
  | { status: "error"; runId: string; error: string }
> {
  const { runId, completion } = await executeCodemodeInObject(
    input.codemode,
    {
      kind: "module-build",
      entry: input.entry,
      modules: input.modules,
      dependencies: input.dependencies,
    },
    { kind: "file", path: input.entry },
    [],
    null,
  );
  if (completion.status === "failed") {
    return { status: "error", runId, error: completion.error.message };
  }
  const compiled = z
    .strictObject({ bundle: codemodeWorkerBundleSchema, warnings: z.array(z.string()) })
    .parse(completion.value);
  return { status: "success", runId, ...compiled };
}

type CompiledModuleExecutionInput = {
  bundle: WorkerBundle;
  invocation: string | null;
  input: unknown;
  providers: ResolvedProvider[];
  codemode: CodemodeRunner;
  origin: CodemodeRunOrigin;
  signal: AbortSignal | null;
};

/** Returns the module's value or raises its failure; consumers need not interpret execution logs. */
export async function runBackofficeCompiledModule(
  input: CompiledModuleExecutionInput,
): Promise<unknown> {
  const { completion } = await executeBackofficeCompiledModule(input);
  if (completion.status === "failed") {
    throw decodeCodemodeError(completion.error);
  }
  return completion.value;
}

/** Executes a precompiled module with fresh capabilities and logs; null invocation runs top-level code only. */
export async function executeBackofficeCompiledModule(
  input: CompiledModuleExecutionInput,
): Promise<CodemodeExecution<Extract<CodemodeRunActivation, { kind: "compiled" }>>> {
  return await executeCodemodeInObject(
    input.codemode,
    {
      kind: "compiled",
      bundle: input.bundle,
      invocation: input.invocation,
      input: input.input,
      providers: codemodeProviderManifest(input.providers),
      timeoutMs: 10_000,
    },
    input.origin,
    input.providers,
    input.signal,
  );
}
