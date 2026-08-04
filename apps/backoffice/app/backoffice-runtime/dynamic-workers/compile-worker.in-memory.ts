import type { WorkerCompiler } from "./compile-worker";
import { createWorkerBundle } from "./worker-bundle";

export const compileInMemoryWorker: WorkerCompiler = async (input) => {
  if (Object.keys(input.dependencies ?? {}).length > 0) {
    throw new Error("In-memory Worker compilation does not support npm dependencies.");
  }

  const sourcePaths = Object.keys(input.files);
  if (
    sourcePaths.length !== 1 ||
    sourcePaths[0] !== input.entryPoint ||
    !input.entryPoint.endsWith(".js")
  ) {
    throw new Error("In-memory Worker compilation requires one JavaScript entry point.");
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
