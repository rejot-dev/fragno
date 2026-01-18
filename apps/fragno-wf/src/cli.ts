#!/usr/bin/env node

import { cli, define } from "gunshi";
import type { Args, Command } from "gunshi";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { workflowsListCommand } from "./commands/workflows/list.js";
import { instancesListCommand } from "./commands/instances/list.js";
import { instancesGetCommand } from "./commands/instances/get.js";
import { instancesHistoryCommand } from "./commands/instances/history.js";
import { instancesLogsCommand } from "./commands/instances/logs.js";
import { instancesCreateCommand } from "./commands/instances/create.js";
import { instancesSendEventCommand } from "./commands/instances/send-event.js";
import { createManageCommand } from "./commands/instances/manage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));
const version = packageJson.version as string;

export const workflowsCommand = define({
  name: "workflows",
  description: "Workflows management commands",
});

export const instancesCommand = define({
  name: "instances",
  description: "Workflow instance commands",
});

const workflowsSubCommands: Map<string, Command<Args>> = new Map();
workflowsSubCommands.set("list", workflowsListCommand as Command<Args>);

const instancesSubCommands: Map<string, Command<Args>> = new Map();
instancesSubCommands.set("list", instancesListCommand as Command<Args>);
instancesSubCommands.set("get", instancesGetCommand as Command<Args>);
instancesSubCommands.set("history", instancesHistoryCommand as Command<Args>);
instancesSubCommands.set("logs", instancesLogsCommand as Command<Args>);
instancesSubCommands.set("create", instancesCreateCommand as Command<Args>);
instancesSubCommands.set("send-event", instancesSendEventCommand as Command<Args>);
instancesSubCommands.set(
  "pause",
  createManageCommand("pause", "Pause a workflow instance") as Command<Args>,
);
instancesSubCommands.set(
  "resume",
  createManageCommand("resume", "Resume a workflow instance") as Command<Args>,
);
instancesSubCommands.set(
  "restart",
  createManageCommand("restart", "Restart a workflow instance") as Command<Args>,
);
instancesSubCommands.set(
  "terminate",
  createManageCommand("terminate", "Terminate a workflow instance") as Command<Args>,
);

const printMainHelp = () => {
  console.log("Workflow management CLI for Fragno");
  console.log("");
  console.log("USAGE:");
  console.log("  fragno-wf <COMMAND>");
  console.log("");
  console.log("COMMANDS:");
  console.log("  workflows            List workflows");
  console.log("  instances            Manage workflow instances");
  console.log("");
  console.log("GLOBAL OPTIONS:");
  console.log("  -b, --base-url        Workflow fragment base URL");
  console.log("  -H, --header          Extra HTTP header (repeatable)");
  console.log("  --timeout             Request timeout in ms (default: 15000)");
  console.log("  --retries             Retry count for network/5xx/429 (default: 2)");
  console.log("  --retry-delay         Retry delay in ms (default: 500)");
  console.log("");
  console.log("ENVIRONMENT:");
  console.log("  FRAGNO_WF_BASE_URL     Default base URL");
  console.log("  FRAGNO_WF_HEADERS      Extra headers separated by ';' or newlines");
  console.log("  FRAGNO_WF_TIMEOUT_MS   Default timeout in ms");
  console.log("  FRAGNO_WF_RETRIES      Default retry count");
  console.log("  FRAGNO_WF_RETRY_DELAY_MS Default retry delay in ms");
  console.log("");
  console.log("EXAMPLES:");
  console.log("  fragno-wf workflows list -b https://host/api/workflows");
  console.log("  fragno-wf instances list -b https://host/api/workflows -w approvals");
  console.log("  fragno-wf instances get -b https://host/api/workflows -w approvals -i inst_123");
  console.log(
    "  fragno-wf instances history -b https://host/api/workflows -w approvals -i inst_123",
  );
  console.log(
    "  fragno-wf instances logs -b https://host/api/workflows -w approvals -i inst_123 --follow",
  );
  console.log(
    '  fragno-wf instances create -b https://host/api/workflows -w approvals --params \'{"userId":"u_1"}\'',
  );
  console.log(
    "  fragno-wf instances send-event -b https://host/api/workflows -w approvals -i inst_123 -t approved",
  );
};

const printWorkflowsHelp = () => {
  console.log("Workflows commands");
  console.log("");
  console.log("USAGE:");
  console.log("  fragno-wf workflows <COMMAND>");
  console.log("");
  console.log("COMMANDS:");
  console.log("  list                  List workflows");
  console.log("");
  console.log("EXAMPLES:");
  console.log("  fragno-wf workflows list -b https://host/api/workflows");
};

const printInstancesHelp = () => {
  console.log("Instances commands");
  console.log("");
  console.log("USAGE:");
  console.log("  fragno-wf instances <COMMAND>");
  console.log("");
  console.log("COMMANDS:");
  console.log("  list                  List instances");
  console.log("  get                   Get instance details");
  console.log("  history               Show instance history");
  console.log("  logs                  Show instance logs");
  console.log("  create                Create an instance");
  console.log("  pause                 Pause an instance");
  console.log("  resume                Resume an instance");
  console.log("  restart               Restart an instance");
  console.log("  terminate             Terminate an instance");
  console.log("  send-event            Send an event to an instance");
  console.log("");
  console.log("EXAMPLES:");
  console.log("  fragno-wf instances list -b https://host/api/workflows -w approvals");
  console.log("  fragno-wf instances get -b https://host/api/workflows -w approvals -i inst_123");
  console.log("  fragno-wf instances pause -b https://host/api/workflows -w approvals -i inst_123");
  console.log(
    "  fragno-wf instances send-event -b https://host/api/workflows -w approvals -i inst_123 -t approved",
  );
};

export async function run() {
  try {
    const args = process.argv.slice(2);

    if (!args.length || args[0] === "--help" || args[0] === "-h") {
      printMainHelp();
      return;
    }

    if (args[0] === "--version" || args[0] === "-v") {
      console.log(version);
      return;
    }

    if (args[0] === "workflows") {
      const subCommandName = args[1];
      if (!subCommandName || subCommandName === "--help" || subCommandName === "-h") {
        printWorkflowsHelp();
        return;
      }
      if (subCommandName === "--version" || subCommandName === "-v") {
        console.log(version);
        return;
      }

      const subCommand = workflowsSubCommands.get(subCommandName);
      if (!subCommand) {
        console.error(`Unknown command: ${subCommandName}`);
        console.log("");
        console.log("Run 'fragno-wf workflows --help' for available commands.");
        process.exit(1);
      }

      await cli(args.slice(2), subCommand, {
        name: `fragno-wf workflows ${subCommandName}`,
        version,
      });
      return;
    }

    if (args[0] === "instances") {
      const subCommandName = args[1];
      if (!subCommandName || subCommandName === "--help" || subCommandName === "-h") {
        printInstancesHelp();
        return;
      }
      if (subCommandName === "--version" || subCommandName === "-v") {
        console.log(version);
        return;
      }

      const subCommand = instancesSubCommands.get(subCommandName);
      if (!subCommand) {
        console.error(`Unknown command: ${subCommandName}`);
        console.log("");
        console.log("Run 'fragno-wf instances --help' for available commands.");
        process.exit(1);
      }

      await cli(args.slice(2), subCommand, {
        name: `fragno-wf instances ${subCommandName}`,
        version,
      });
      return;
    }

    console.error(`Unknown command: ${args[0]}`);
    console.log("");
    console.log("Run 'fragno-wf --help' for available commands.");
    process.exit(1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (import.meta.main) {
  await run();
}

export {
  workflowsListCommand,
  instancesListCommand,
  instancesGetCommand,
  instancesHistoryCommand,
  instancesLogsCommand,
  instancesCreateCommand,
  instancesSendEventCommand,
};
