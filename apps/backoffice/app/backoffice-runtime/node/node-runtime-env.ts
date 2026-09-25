import type { BackofficeRuntimeEnv } from "../backoffice-runtime-env";
import { compileNodeWorker } from "../dynamic-workers/compile-node-worker";
import { createDenoWorkerLoader, resolveDenoCodemodeExecutable } from "./deno-worker-loader";

export type CreateNodeBackofficeRuntimeEnvInput = {
  denoExecutable: string | undefined;
  env: Omit<BackofficeRuntimeEnv, "LOADER" | "compileWorker">;
};

/** Creates the production Node environment with Deno-isolated codemode execution. */
export async function createNodeBackofficeRuntimeEnv(
  input: CreateNodeBackofficeRuntimeEnvInput,
): Promise<BackofficeRuntimeEnv> {
  const denoExecutable = await resolveDenoCodemodeExecutable(input.denoExecutable);
  return {
    ...input.env,
    LOADER: createDenoWorkerLoader(denoExecutable),
    compileWorker: compileNodeWorker,
  };
}
