import type { WorkerCompiler } from "@fragno-dev/codemode/compiler/compile-worker";
import { createWorkerBundle } from "@fragno-dev/codemode/compiler/worker-bundle";
import { createCodemodeBridgeExecution } from "@fragno-dev/codemode/remote/codemode-bridge-execution";
import { env } from "cloudflare:workers";

/**
 * Loads Backoffice's generated JavaScript modules unchanged. Bundling, npm installation, and type
 * checking are covered by cf-sandbox-bridge's compiler tests. Requested dependencies are ignored, so
 * a module importing one fails when the Worker Loader loads it.
 */
const compileWorker: WorkerCompiler = async (input) => ({
  bundle: createWorkerBundle({
    mainModule: input.entryPoint,
    modules: input.files,
    runtime: input.runtime,
  }),
  warnings: [],
});

/**
 * Serves the bridge's `CodemodeExecutor` in this test Worker, with its own Worker Loader. The real
 * service-binding hop is covered by cf-sandbox-bridge's executor tests. This runs in-process rather
 * than behind a service binding: a binding into this test Worker loads `vitest-env.ts` and every
 * Durable Object it exports during the first execution.
 */
const testEnv = env as typeof env & { LOADER: WorkerLoader };
Object.assign(env, {
  CODEMODE_EXECUTOR: createCodemodeBridgeExecution(
    { loader: testEnv.LOADER, compile: compileWorker },
    {
      waitUntil(promise) {
        void promise.catch(() => {});
      },
    },
  ),
});
