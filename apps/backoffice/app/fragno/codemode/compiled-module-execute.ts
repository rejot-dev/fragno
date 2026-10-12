import type { CompiledWorker } from "@fragno-dev/codemode/compiler/compile-worker";
import type { WorkerBundle } from "@fragno-dev/codemode/compiler/worker-bundle";
import { codemodeWorkerBundleSchema } from "@fragno-dev/codemode/execution/codemode-worker-bundle";
import type { ResolvedProvider } from "@fragno-dev/codemode/runtime-api";
import { z } from "zod";

import type { CodemodeObject } from "@/backoffice-runtime/object-registry";

import type { CodemodeRunCompletion } from "./codemode-fragment";
import { codemodeProviderManifest, executeCodemodeInObject } from "./codemode-object-execute";

/** Bundles an ES module without executing it or choosing a consumer-specific entrypoint. */
export async function buildBackofficeJavaScriptModule(input: {
  code: string;
  dependencies: Record<string, string>;
  codemode: CodemodeObject;
}): Promise<CompiledWorker> {
  const completion = await executeCodemodeInObject(
    input.codemode,
    { kind: "module-build", code: input.code, dependencies: input.dependencies },
    [],
    null,
  );
  return z
    .strictObject({ bundle: codemodeWorkerBundleSchema, warnings: z.array(z.string()) })
    .parse(requireCompletedModuleValue(completion));
}

type CompiledModuleExecutionInput = {
  bundle: WorkerBundle;
  invocation: string | null;
  input: unknown;
  providers: ResolvedProvider[];
  codemode: CodemodeObject;
  signal: AbortSignal | null;
};

/** Returns the module's value or raises its failure; consumers need not interpret execution logs. */
export async function runBackofficeCompiledModule(
  input: CompiledModuleExecutionInput,
): Promise<unknown> {
  return requireCompletedModuleValue(await executeBackofficeCompiledModule(input));
}

/** Executes a precompiled module with fresh capabilities and logs; null invocation runs top-level code only. */
export async function executeBackofficeCompiledModule(
  input: CompiledModuleExecutionInput,
): Promise<CodemodeRunCompletion> {
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
    input.providers,
    input.signal,
  );
}

function requireCompletedModuleValue(completion: CodemodeRunCompletion): unknown {
  if (completion.status === "failed") {
    throw new Error(completion.error.message);
  }
  return completion.value;
}
