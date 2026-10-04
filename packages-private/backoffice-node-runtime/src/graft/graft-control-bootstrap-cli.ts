import { stat } from "node:fs/promises";
import path from "node:path";

import { publishGraftControlDatabase, reserveGraftControlDatabase } from "./graft-control-database";

const usage = `Backoffice Node runtime CLI

Usage:
  backoffice-node-runtime bootstrap reserve [--graft-config <path>]
  backoffice-node-runtime bootstrap publish --control-remote-log-id <id> [--graft-config <path>]

Options:
  --graft-config <path>           Graft TOML file; defaults to GRAFT_CONFIG or ./graft.toml
  --control-remote-log-id <id>    Reserved control log identity required by publish
  -h, --help                      Show this help`;

type GraftControlBootstrapCommand =
  | { operation: "reserve"; graftConfigPath: string }
  | { operation: "publish"; graftConfigPath: string; controlRemoteLogId: string };

/** Runs the control-history bootstrap CLI and returns its process exit code. */
export async function runBackofficeNodeRuntimeCli(arguments_: string[]): Promise<number> {
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    console.log(usage);
    return 0;
  }

  try {
    const command = parseGraftControlBootstrapCommand(arguments_, process.env);
    await requireGraftConfigFile(command.graftConfigPath);
    if (command.operation === "reserve") {
      const controlRemoteLogId = reserveGraftControlDatabase(command.graftConfigPath);
      console.log(`GRAFT_CONTROL_REMOTE_LOG_RESERVED:${JSON.stringify({ controlRemoteLogId })}`);
      return 0;
    }
    const controlRemoteLogId = publishGraftControlDatabase(
      command.graftConfigPath,
      command.controlRemoteLogId,
    );
    console.log(
      `GRAFT_CONTROL_HISTORY_PUBLISHED:${JSON.stringify({
        graftConfigPath: command.graftConfigPath,
        controlRemoteLogId,
      })}`,
    );
    return 0;
  } catch (error) {
    console.error(
      `BACKOFFICE_NODE_RUNTIME_CLI_ERROR:${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(usage);
    return 1;
  }
}

function parseGraftControlBootstrapCommand(
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
): GraftControlBootstrapCommand {
  const positionals: string[] = [];
  let graftConfigPath = environment["GRAFT_CONFIG"]?.trim() || "graft.toml";
  let controlRemoteLogId: string | null = null;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--graft-config") {
      graftConfigPath = requireOptionValue(arguments_[index + 1], "--graft-config");
      index += 1;
      continue;
    }
    if (argument.startsWith("--graft-config=")) {
      graftConfigPath = requireOptionValue(
        argument.slice("--graft-config=".length),
        "--graft-config",
      );
      continue;
    }
    if (argument === "--control-remote-log-id") {
      controlRemoteLogId = requireOptionValue(arguments_[index + 1], "--control-remote-log-id");
      index += 1;
      continue;
    }
    if (argument.startsWith("--control-remote-log-id=")) {
      controlRemoteLogId = requireOptionValue(
        argument.slice("--control-remote-log-id=".length),
        "--control-remote-log-id",
      );
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`BACKOFFICE_NODE_RUNTIME_CLI_OPTION_UNKNOWN:${argument}`);
    }
    positionals.push(argument);
  }

  if (positionals[0] !== "bootstrap") {
    throw new Error("BACKOFFICE_NODE_RUNTIME_CLI_COMMAND_REQUIRED:bootstrap");
  }
  const operation = positionals[1];
  if ((operation !== "reserve" && operation !== "publish") || positionals.length !== 2) {
    throw new Error("BACKOFFICE_NODE_RUNTIME_CLI_BOOTSTRAP_COMMAND_REQUIRED:reserve|publish");
  }
  const resolvedGraftConfigPath = path.resolve(graftConfigPath);
  if (operation === "reserve") {
    if (controlRemoteLogId !== null) {
      throw new Error("BACKOFFICE_NODE_RUNTIME_CLI_RESERVE_CONTROL_LOG_ID_FORBIDDEN");
    }
    return { operation, graftConfigPath: resolvedGraftConfigPath };
  }
  if (controlRemoteLogId === null) {
    throw new Error("BACKOFFICE_NODE_RUNTIME_CLI_CONTROL_LOG_ID_REQUIRED");
  }
  return {
    operation,
    graftConfigPath: resolvedGraftConfigPath,
    controlRemoteLogId,
  };
}

function requireOptionValue(value: string | undefined, name: string): string {
  if (!value || value.startsWith("-")) {
    throw new Error(`BACKOFFICE_NODE_RUNTIME_CLI_OPTION_VALUE_REQUIRED:${name}`);
  }
  return value;
}

async function requireGraftConfigFile(configPath: string): Promise<void> {
  try {
    const metadata = await stat(configPath);
    if (!metadata.isFile()) {
      throw new Error(`BACKOFFICE_NODE_RUNTIME_GRAFT_CONFIG_NOT_FILE:${configPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`BACKOFFICE_NODE_RUNTIME_GRAFT_CONFIG_NOT_FOUND:${configPath}`);
    }
    throw error;
  }
}
