import type { WorkerCompiler } from "./compile-worker";
import { createWorkerBundle } from "./worker-bundle";

/** Compiles the single bundled JavaScript module accepted by Node's Deno codemode runtime. */
export const compileNodeWorker: WorkerCompiler = async (input) => {
  if (Object.keys(input.dependencies ?? {}).length > 0) {
    throw new Error("Node codemode compilation does not support npm dependencies.");
  }

  const sourcePaths = Object.keys(input.files);
  if (
    sourcePaths.length !== 1 ||
    sourcePaths[0] !== input.entryPoint ||
    !input.entryPoint.endsWith(".js")
  ) {
    throw new Error("Node codemode compilation requires one JavaScript entry point.");
  }

  return {
    bundle: createWorkerBundle({
      mainModule: input.entryPoint,
      modules: input.files,
      runtime: input.runtime,
    }),
    warnings: [],
  };
};
