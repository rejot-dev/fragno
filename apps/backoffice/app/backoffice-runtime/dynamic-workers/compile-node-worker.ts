import type { WorkerCompiler } from "@fragno-dev/codemode/compiler/compile-worker";
import { createWorkerBundle } from "@fragno-dev/codemode/compiler/worker-bundle";

/** Adapts one JavaScript entrypoint for the in-process scenario loader, never production execution. */
export const compileNodeWorker: WorkerCompiler = async (input) => {
  if (Object.keys(input.dependencies).length > 0) {
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
