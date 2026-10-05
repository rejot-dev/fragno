import type { WorkerTypeChecker } from "@fragno-dev/codemode/compiler/compile-worker";
import { createCodemodeCompilerHttpClient } from "@fragno-dev/codemode/compiler/compiler-service-client";
import { createCodemodeNodeExecutor } from "@fragno-dev/codemode/remote/codemode-node-executor";

import { createCloudflareSandboxBridgeProvider } from "@/sandbox/cloudflare-sandbox-bridge-provider";
import { createCloudflareSandboxPhysicalId } from "@/sandbox/cloudflare-sandbox-id";
import { CLOUDFLARE_SANDBOX_PROVIDER } from "@/sandbox/contracts";
import type { CreateSandboxRuntimeProviders } from "@/sandbox/contracts";

import type { BackofficeRuntimeEnv } from "../backoffice-runtime-env";

export type CreateNodeBackofficeRuntimeConfigurationInput = {
  bridgeUrl: string | undefined;
  bridgeApiKey: string | undefined;
  env: Omit<BackofficeRuntimeEnv, "codemode">;
};

export type NodeBackofficeRuntimeConfiguration = {
  runtimeEnv: BackofficeRuntimeEnv;
  workerTypeChecker: WorkerTypeChecker;
  createSandboxProviders: CreateSandboxRuntimeProviders;
};

/** Creates Node runtime configuration backed by the bridge's WebSocket and HTTP APIs. */
export function createNodeBackofficeRuntimeConfiguration(
  input: CreateNodeBackofficeRuntimeConfigurationInput,
): NodeBackofficeRuntimeConfiguration {
  if (!input.bridgeUrl || !input.bridgeApiKey) {
    throw new Error(
      "Node codemode and sandbox execution require CLOUDFLARE_BRIDGE_URL and CLOUDFLARE_BRIDGE_API_KEY in .dev.vars; no local bridge fallback is available.",
    );
  }
  const bridgeUrl = input.bridgeUrl;
  const bridgeApiKey = input.bridgeApiKey;
  const compiler = createCodemodeCompilerHttpClient({
    url: bridgeUrl,
    apiKey: bridgeApiKey,
  });
  return {
    runtimeEnv: {
      ...input.env,
      codemode: {
        remoteExecutor: createCodemodeNodeExecutor({
          url: bridgeUrl,
          apiKey: bridgeApiKey,
        }),
      },
    },
    workerTypeChecker: compiler.typeCheckFiles,
    createSandboxProviders(managerId) {
      return {
        [CLOUDFLARE_SANDBOX_PROVIDER]: createCloudflareSandboxBridgeProvider({
          bridgeUrl,
          apiKey: bridgeApiKey,
          resolveSandboxId: async (sandboxId) =>
            await createCloudflareSandboxPhysicalId(managerId, sandboxId),
        }),
      };
    },
  };
}
