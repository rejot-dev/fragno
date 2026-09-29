import { createCodemodeNodeExecutor } from "@fragno-dev/codemode/transport/codemode-node-client";

import type { BackofficeRuntimeEnv } from "../backoffice-runtime-env";

export type CreateNodeBackofficeRuntimeEnvInput = {
  executorUrl: string | undefined;
  executorApiKey: string | undefined;
  env: Omit<BackofficeRuntimeEnv, "codemode">;
};

/** Creates Node-owned runtime services without loading or compiling guest code in the VPS process. */
export async function createNodeBackofficeRuntimeEnv(
  input: CreateNodeBackofficeRuntimeEnvInput,
): Promise<BackofficeRuntimeEnv> {
  if (!input.executorUrl || !input.executorApiKey) {
    throw new Error(
      "Node codemode requires CODEMODE_EXECUTOR_URL and CODEMODE_EXECUTOR_API_KEY in .dev.vars; no local executor fallback is available.",
    );
  }
  return {
    ...input.env,
    codemode: {
      remoteExecutor: createCodemodeNodeExecutor({
        url: input.executorUrl,
        apiKey: input.executorApiKey,
      }),
    },
  };
}
