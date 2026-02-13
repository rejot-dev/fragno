#!/usr/bin/env node

import { cli } from "gunshi";
import type { Args, Command } from "gunshi";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clientCommand } from "./client.js";
import { serveCommand } from "./server.js";
import { scenarioCommand } from "./scenario.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));
const version = packageJson.version as string;

const subCommands: Map<string, Command<Args>> = new Map();
subCommands.set("client", clientCommand as Command<Args>);
subCommands.set("serve", serveCommand as Command<Args>);
subCommands.set("scenario", scenarioCommand as Command<Args>);

const printMainHelp = () => {
  console.log("Fragno Lofi CLI");
  console.log("");
  console.log("USAGE:");
  console.log("  fragno-lofi <COMMAND>");
  console.log("  fragno-lofi --endpoint <url> --module <path> [options]");
  console.log("");
  console.log("COMMANDS:");
  console.log("  serve                 Start a local server");
  console.log("  client                Run a client (sync + submit)");
  console.log("  scenario              Run a multi-client scenario");
  console.log("");
  console.log("GLOBAL OPTIONS:");
  console.log("  -v, --version         Print version");
  console.log("  -h, --help            Show help");
  console.log("");
  console.log("EXAMPLES:");
  console.log("  fragno-lofi client --endpoint http://localhost:4100 --module ./client.ts");
  console.log("  fragno-lofi serve --module ./server.ts --port 4100");
  console.log("  fragno-lofi scenario --file ./scenario.ts");
  console.log(
    "  fragno-lofi --endpoint http://localhost:3000/api/fragno-db-comment --module ./client.ts --timeout 5",
  );
};

const printClientHelp = () => {
  console.log("Lofi client");
  console.log("");
  console.log("USAGE:");
  console.log("  fragno-lofi client --endpoint <url> [options]");
  console.log("");
  console.log("OPTIONS:");
  console.log("  -e, --endpoint        Fragment base URL or outbox URL (required)");
  console.log("  -t, --timeout         Seconds to run (default: 5)");
  console.log("  -i, --poll-interval   Poll interval in ms (default: 1000)");
  console.log("  --limit               Outbox page size (default: 500)");
  console.log("  --endpoint-name       Override local endpoint name");
  console.log("  --module              Path to client module with schemas/commands (required)");
  console.log("  --command             Queue a command by name before syncing");
  console.log("  --input               JSON input payload for --command");
  console.log("  --submit              Submit queued commands before syncing");
  console.log("  --no-optimistic        Disable optimistic execution");
  console.log("");
  console.log("EXAMPLES:");
  console.log(
    "  fragno-lofi client --endpoint http://localhost:3000/api/fragno-db-comment --module ./client.ts --timeout 5",
  );
};

const printServeHelp = () => {
  console.log("Lofi server");
  console.log("");
  console.log("USAGE:");
  console.log("  fragno-lofi serve --module <path> [options]");
  console.log("");
  console.log("OPTIONS:");
  console.log("  -m, --module          Path to a server module exporting a fragment");
  console.log("  -p, --port            Port to listen on (default: 4100)");
  console.log("");
  console.log("EXAMPLES:");
  console.log("  fragno-lofi serve --module ./server.ts --port 4100");
};

const printScenarioHelp = () => {
  console.log("Lofi scenario runner");
  console.log("");
  console.log("USAGE:");
  console.log("  fragno-lofi scenario --file <path>");
  console.log("");
  console.log("OPTIONS:");
  console.log("  -f, --file            Path to a scenario module");
  console.log("");
  console.log("EXAMPLES:");
  console.log("  fragno-lofi scenario --file ./scenario.ts");
};

export async function run() {
  const args = process.argv.slice(2);

  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    printMainHelp();
    return;
  }

  if (args[0] === "--version" || args[0] === "-v") {
    console.log(version);
    return;
  }

  const subCommandName = args[0];
  const subCommand = subCommands.get(subCommandName);

  if (subCommand) {
    const next = args[1];
    if (!next || next === "--help" || next === "-h") {
      if (subCommandName === "client") {
        printClientHelp();
      } else if (subCommandName === "serve") {
        printServeHelp();
      } else if (subCommandName === "scenario") {
        printScenarioHelp();
      }
      return;
    }
    if (next === "--version" || next === "-v") {
      console.log(version);
      return;
    }

    await cli(args.slice(1), subCommand, {
      name: `fragno-lofi ${subCommandName}`,
      version,
    });
    return;
  }

  if (subCommandName.startsWith("-")) {
    await cli(args, clientCommand as Command<Args>, {
      name: "fragno-lofi",
      version,
    });
    return;
  }

  console.error(`Unknown command: ${subCommandName}`);
  console.log("");
  console.log("Run 'fragno-lofi --help' for available commands.");
  process.exit(1);
}

if (import.meta.main) {
  await run();
}
