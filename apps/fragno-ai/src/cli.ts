#!/usr/bin/env node

import { cli, define } from "gunshi";
import type { Args, Command } from "gunshi";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { threadsListCommand } from "./commands/threads/list.js";
import { threadsGetCommand } from "./commands/threads/get.js";
import { threadsCreateCommand } from "./commands/threads/create.js";
import { threadsUpdateCommand } from "./commands/threads/update.js";
import { threadsDeleteCommand } from "./commands/threads/delete.js";
import { messagesListCommand } from "./commands/messages/list.js";
import { messagesAppendCommand } from "./commands/messages/append.js";
import { runsListCommand } from "./commands/runs/list.js";
import { runsGetCommand } from "./commands/runs/get.js";
import { runsCreateCommand } from "./commands/runs/create.js";
import { runsStreamCommand } from "./commands/runs/stream.js";
import { runsCancelCommand } from "./commands/runs/cancel.js";
import { runsEventsCommand } from "./commands/runs/events.js";
import { artifactsListCommand } from "./commands/artifacts/list.js";
import { artifactsGetCommand } from "./commands/artifacts/get.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));
const version = packageJson.version as string;

export const threadsCommand = define({
  name: "threads",
  description: "Thread management commands",
});

export const messagesCommand = define({
  name: "messages",
  description: "Thread message commands",
});

export const runsCommand = define({
  name: "runs",
  description: "Run management commands",
});

export const artifactsCommand = define({
  name: "artifacts",
  description: "Artifact commands",
});

const threadsSubCommands: Map<string, Command<Args>> = new Map();
threadsSubCommands.set("list", threadsListCommand as Command<Args>);
threadsSubCommands.set("get", threadsGetCommand as Command<Args>);
threadsSubCommands.set("create", threadsCreateCommand as Command<Args>);
threadsSubCommands.set("update", threadsUpdateCommand as Command<Args>);
threadsSubCommands.set("delete", threadsDeleteCommand as Command<Args>);

const messagesSubCommands: Map<string, Command<Args>> = new Map();
messagesSubCommands.set("list", messagesListCommand as Command<Args>);
messagesSubCommands.set("append", messagesAppendCommand as Command<Args>);

const runsSubCommands: Map<string, Command<Args>> = new Map();
runsSubCommands.set("list", runsListCommand as Command<Args>);
runsSubCommands.set("get", runsGetCommand as Command<Args>);
runsSubCommands.set("create", runsCreateCommand as Command<Args>);
runsSubCommands.set("stream", runsStreamCommand as Command<Args>);
runsSubCommands.set("cancel", runsCancelCommand as Command<Args>);
runsSubCommands.set("events", runsEventsCommand as Command<Args>);

const artifactsSubCommands: Map<string, Command<Args>> = new Map();
artifactsSubCommands.set("list", artifactsListCommand as Command<Args>);
artifactsSubCommands.set("get", artifactsGetCommand as Command<Args>);

const printMainHelp = () => {
  console.log("AI fragment CLI for Fragno");
  console.log("");
  console.log("USAGE:");
  console.log("  fragno-ai <COMMAND>");
  console.log("");
  console.log("COMMANDS:");
  console.log("  threads              Manage threads");
  console.log("  messages             Manage thread messages");
  console.log("  runs                 Manage runs");
  console.log("  artifacts            Manage artifacts");
  console.log("");
  console.log("GLOBAL OPTIONS:");
  console.log("  -b, --base-url        AI fragment base URL");
  console.log("  -H, --header          Extra HTTP header (repeatable)");
  console.log("  --timeout             Request timeout in ms (default: 15000)");
  console.log("  --retries             Retry count for network/5xx/429 (default: 2)");
  console.log("  --retry-delay         Retry delay in ms (default: 500)");
  console.log("");
  console.log("ENVIRONMENT:");
  console.log("  FRAGNO_AI_BASE_URL     Default base URL");
  console.log("  FRAGNO_AI_HEADERS      Extra headers separated by ';' or newlines");
  console.log("  FRAGNO_AI_TIMEOUT_MS   Default timeout in ms");
  console.log("  FRAGNO_AI_RETRIES      Default retry count");
  console.log("  FRAGNO_AI_RETRY_DELAY_MS Default retry delay in ms");
  console.log("");
  console.log("EXAMPLES:");
  console.log("  fragno-ai threads list -b https://host/api/ai");
  console.log('  fragno-ai threads create -b https://host/api/ai --title "Demo"');
  console.log(
    '  fragno-ai messages append -b https://host/api/ai --thread th_123 --content "Hello"',
  );
  console.log("  fragno-ai runs create -b https://host/api/ai --thread th_123");
  console.log("  fragno-ai runs stream -b https://host/api/ai --thread th_123");
};

const printThreadsHelp = () => {
  console.log("Threads commands");
  console.log("");
  console.log("USAGE:");
  console.log("  fragno-ai threads <COMMAND>");
  console.log("");
  console.log("COMMANDS:");
  console.log("  list                  List threads");
  console.log("  get                   Get a thread");
  console.log("  create                Create a thread");
  console.log("  update                Update a thread");
  console.log("  delete                Delete a thread (admin route)");
  console.log("");
  console.log("EXAMPLES:");
  console.log("  fragno-ai threads list -b https://host/api/ai");
  console.log("  fragno-ai threads get -b https://host/api/ai --thread th_123");
};

const printMessagesHelp = () => {
  console.log("Messages commands");
  console.log("");
  console.log("USAGE:");
  console.log("  fragno-ai messages <COMMAND>");
  console.log("");
  console.log("COMMANDS:");
  console.log("  list                  List messages for a thread");
  console.log("  append                Append a message to a thread");
  console.log("");
  console.log("EXAMPLES:");
  console.log("  fragno-ai messages list -b https://host/api/ai --thread th_123");
  console.log('  fragno-ai messages append -b https://host/api/ai --thread th_123 --content "Hi"');
};

const printRunsHelp = () => {
  console.log("Runs commands");
  console.log("");
  console.log("USAGE:");
  console.log("  fragno-ai runs <COMMAND>");
  console.log("");
  console.log("COMMANDS:");
  console.log("  list                  List runs for a thread");
  console.log("  get                   Get run details");
  console.log("  create                Create a run");
  console.log("  stream                Start a streamed run (NDJSON)");
  console.log("  cancel                Cancel a run");
  console.log("  events                List run events");
  console.log("");
  console.log("EXAMPLES:");
  console.log("  fragno-ai runs list -b https://host/api/ai --thread th_123");
  console.log("  fragno-ai runs get -b https://host/api/ai --run run_123");
  console.log("  fragno-ai runs stream -b https://host/api/ai --thread th_123");
};

const printArtifactsHelp = () => {
  console.log("Artifacts commands");
  console.log("");
  console.log("USAGE:");
  console.log("  fragno-ai artifacts <COMMAND>");
  console.log("");
  console.log("COMMANDS:");
  console.log("  list                  List artifacts for a run");
  console.log("  get                   Get an artifact");
  console.log("");
  console.log("EXAMPLES:");
  console.log("  fragno-ai artifacts list -b https://host/api/ai --run run_123");
};

const runSubCommand = async (
  args: string[],
  subCommands: Map<string, Command<Args>>,
  category: string,
  printHelp: () => void,
) => {
  const subCommandName = args[1];
  if (!subCommandName || subCommandName === "--help" || subCommandName === "-h") {
    printHelp();
    return;
  }
  if (subCommandName === "--version" || subCommandName === "-v") {
    console.log(version);
    return;
  }

  const subCommand = subCommands.get(subCommandName);
  if (!subCommand) {
    console.error(`Unknown command: ${subCommandName}`);
    console.log("");
    console.log(`Run 'fragno-ai ${category} --help' for available commands.`);
    process.exit(1);
  }

  await cli(args.slice(2), subCommand, {
    name: `fragno-ai ${category} ${subCommandName}`,
    version,
  });
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

    if (args[0] === "threads") {
      await runSubCommand(args, threadsSubCommands, "threads", printThreadsHelp);
      return;
    }

    if (args[0] === "messages") {
      await runSubCommand(args, messagesSubCommands, "messages", printMessagesHelp);
      return;
    }

    if (args[0] === "runs") {
      await runSubCommand(args, runsSubCommands, "runs", printRunsHelp);
      return;
    }

    if (args[0] === "artifacts") {
      await runSubCommand(args, artifactsSubCommands, "artifacts", printArtifactsHelp);
      return;
    }

    console.error(`Unknown command: ${args[0]}`);
    console.log("");
    printMainHelp();
    process.exit(1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}
