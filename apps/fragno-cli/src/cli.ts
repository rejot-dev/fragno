#!/usr/bin/env node

import { cli, define } from "gunshi";
import { generateCommand } from "./commands/db/generate.js";
import { migrateCommand } from "./commands/db/migrate.js";
import { infoCommand } from "./commands/db/info.js";
import { searchCommand } from "./commands/search.js";
import { corpusCommand } from "./commands/corpus.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));
const version = packageJson.version;

// Create a Map of db sub-commands
const dbSubCommands = new Map();
dbSubCommands.set("generate", generateCommand);
dbSubCommands.set("migrate", migrateCommand);
dbSubCommands.set("info", infoCommand);

// Define the db command with nested subcommands
export const dbCommand = define({
  name: "db",
  description: "Database management commands",
});

// Define the main command
export const mainCommand = define({
  name: "fragno-cli",
  description: "Tools for working with Fragno fragments",
});

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);

    // Manual routing for top-level commands
    if (args[0] === "search") {
      // Run search command directly
      await cli(args.slice(1), searchCommand, {
        name: "fragno-cli search",
        version,
      });
    } else if (args[0] === "corpus") {
      // Run corpus command directly
      await cli(args.slice(1), corpusCommand, {
        name: "fragno-cli corpus",
        version,
      });
    } else if (args[0] === "db") {
      // Handle db subcommands
      const subCommandName = args[1];

      if (!subCommandName || subCommandName === "--help" || subCommandName === "-h") {
        // Show db help with subcommands
        console.log("fragno-cli (fragno-cli v" + version + ")");
        console.log("");
        console.log("Database management commands");
        console.log("");
        console.log("USAGE:");
        console.log("  fragno-cli db <COMMAND>");
        console.log("");
        console.log("COMMANDS:");
        console.log(
          "  generate              Generate schema files from FragnoDatabase definitions",
        );
        console.log("  migrate               Run database migrations");
        console.log("  info                  Display database information and migration status");
        console.log("");
        console.log("For more info, run any command with the `--help` flag:");
        console.log("  fragno-cli db generate --help");
        console.log("  fragno-cli db migrate --help");
        console.log("  fragno-cli db info --help");
        console.log("");
        console.log("OPTIONS:");
        console.log("  -h, --help             Display this help message");
        console.log("  -v, --version          Display this version");
      } else if (subCommandName === "--version" || subCommandName === "-v") {
        console.log(version);
      } else {
        // Route to specific db subcommand
        const subCommand = dbSubCommands.get(subCommandName);

        if (!subCommand) {
          console.error(`Unknown command: ${subCommandName}`);
          console.log("");
          console.log("Run 'fragno-cli db --help' for available commands.");
          process.exit(1);
        }

        // Run the subcommand
        await cli(args.slice(2), subCommand, {
          name: `fragno-cli db ${subCommandName}`,
          version,
        });
      }
    } else if (!args.length || args[0] === "--help" || args[0] === "-h") {
      // Show main help
      console.log("fragno-cli (fragno-cli v" + version + ")");
      console.log("");
      console.log("Tools for working with Fragno fragments");
      console.log("");
      console.log("USAGE:");
      console.log("  fragno-cli <COMMAND>");
      console.log("");
      console.log("COMMANDS:");
      console.log("  db                    Database management commands");
      console.log("  search                Search the Fragno documentation");
      console.log("  corpus                View code examples and documentation for Fragno");
      console.log("");
      console.log("For more info, run any command with the `--help` flag:");
      console.log("  fragno-cli db --help");
      console.log("  fragno-cli search --help");
      console.log("  fragno-cli corpus --help");
      console.log("");
      console.log("OPTIONS:");
      console.log("  -h, --help             Display this help message");
      console.log("  -v, --version          Display this version");
    } else if (args[0] === "--version" || args[0] === "-v") {
      console.log(version);
    } else {
      // Unknown command
      console.error(`Unknown command: ${args[0]}`);
      console.log("");
      console.log("Run 'fragno-cli --help' for available commands.");
      process.exit(1);
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

export { generateCommand, migrateCommand, infoCommand, searchCommand, corpusCommand };
