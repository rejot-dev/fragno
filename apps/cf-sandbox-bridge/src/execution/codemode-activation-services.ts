import type { CodemodeActivationServices } from "@fragno-dev/codemode/execution/execute-codemode-activation";

/** Guests compile in this isolate and load through its Worker Loader, whichever protocol asked. */
export function bridgeCodemodeActivationServices(env: Env): CodemodeActivationServices {
  return {
    loader: env.LOADER,
    async compile(input) {
      // Sandbox-only requests should not initialize the compiler runtime.
      const { buildWorkerProject } = await import("../compiler/build-worker-project");
      return await buildWorkerProject(input);
    },
  };
}
