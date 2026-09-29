import type { WorkerTypeChecker } from "@fragno-dev/codemode/compiler/compile-worker";
import { createCodemodeCompilerHttpClient } from "@fragno-dev/codemode/compiler/compiler-service-client";
import { createCodemodeNodeExecutor } from "@fragno-dev/codemode/transport/codemode-node-client";

import type { BackofficeRuntimeEnv } from "../backoffice-runtime-env";

export type CreateNodeBackofficeRuntimeConfigurationInput = {
  bridgeUrl: string | undefined;
  bridgeApiKey: string | undefined;
  env: Omit<BackofficeRuntimeEnv, "codemode">;
};

export type NodeBackofficeRuntimeConfiguration = {
  runtimeEnv: BackofficeRuntimeEnv;
  workerTypeChecker: WorkerTypeChecker;
};

/** Creates Node runtime configuration backed by the bridge's WebSocket and HTTP APIs. */
export function createNodeBackofficeRuntimeConfiguration(
  input: CreateNodeBackofficeRuntimeConfigurationInput,
): NodeBackofficeRuntimeConfiguration {
  if (!input.bridgeUrl || !input.bridgeApiKey) {
    throw new Error(
      "Node codemode requires CLOUDFLARE_BRIDGE_URL and CLOUDFLARE_BRIDGE_API_KEY in .dev.vars; no local bridge fallback is available.",
    );
  }
  const compiler = createCodemodeCompilerHttpClient({
    url: input.bridgeUrl,
    apiKey: input.bridgeApiKey,
  });
  return {
    runtimeEnv: {
      ...input.env,
      codemode: {
        remoteExecutor: createCodemodeNodeExecutor({
          url: input.bridgeUrl,
          apiKey: input.bridgeApiKey,
        }),
      },
    },
    workerTypeChecker: compiler.typeCheckFiles,
  };
}
