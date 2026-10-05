import { stat } from "node:fs/promises";
import path from "node:path";

import type { GraftNodeRuntimeStorage } from "@fragno-private/backoffice-node-runtime/graft-runtime-storage";

/** Resolves and validates the user-provided Graft configuration file. */
export async function readGraftConfigPath(environment: NodeJS.ProcessEnv): Promise<string> {
  const configPath = path.resolve(environment["GRAFT_CONFIG"]?.trim() || "graft.toml");
  try {
    const metadata = await stat(configPath);
    if (!metadata.isFile()) {
      throw new Error(`DEMO_GRAFT_CONFIG_NOT_FILE:${configPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`DEMO_GRAFT_CONFIG_NOT_FOUND:${configPath}`);
    }
    throw error;
  }
  return configPath;
}

/** Reads the complete storage contract required by serving nodes and gateways. */
export async function readServingGraftStorage(
  environment: NodeJS.ProcessEnv,
): Promise<GraftNodeRuntimeStorage> {
  return {
    configPath: await readGraftConfigPath(environment),
    controlRemoteLogId: requireDemoEnvironment(
      environment,
      "BACKOFFICE_NODE_RUNTIME_DEMO_CONTROL_REMOTE_LOG_ID",
    ),
  };
}

/** Requires explicit process configuration at the environment boundary. */
export function requireDemoEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`DEMO_ENVIRONMENT_REQUIRED:${name}`);
  }
  return value;
}
