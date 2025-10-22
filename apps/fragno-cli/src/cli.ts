#!/usr/bin/env node

import { cli, type Command, parseArgs, resolveArgs } from "gunshi";
import { generate } from "./commands/db/generate.js";
import { migrate } from "./commands/db/migrate.js";
import { info } from "./commands/db/info.js";

// Define the db generate command
export const generateCommand: Command = {
  name: "generate",
  description: "Generate schema files from FragnoDatabase definitions",
  args: {
    target: {
      type: "positional" as const,
      description: "Path to the file that exports a FragnoDatabase instance",
    },
    output: {
      type: "string" as const,
      short: "o",
      description:
        "Output path for the generated schema file (default: schema.sql for Kysely, schema.ts for Drizzle)",
    },
    from: {
      type: "string" as const,
      short: "f",
      description: "Source version to generate migration from (default: current database version)",
    },
    to: {
      type: "string" as const,
      short: "t",
      description: "Target version to generate migration to (default: latest schema version)",
    },
    prefix: {
      type: "string" as const,
      short: "p",
      description: "String to prepend to the generated file (e.g., '/* eslint-disable */')",
    },
  },
  run: generate,
};

// Define the db migrate command
export const migrateCommand: Command = {
  name: "migrate",
  description: "Run database migrations",
  args: {
    target: {
      type: "positional" as const,
      description: "Path to the file that exports a FragnoDatabase instance",
    },
    from: {
      type: "string" as const,
      short: "f",
      description: "Expected current database version (validates before migrating)",
    },
    to: {
      type: "string" as const,
      short: "t",
      description: "Target version to migrate to (default: latest schema version)",
    },
  },
  run: migrate,
};

// Define the db info command
export const infoCommand: Command = {
  name: "info",
  description: "Display database information and migration status",
  args: {
    target: {
      type: "positional" as const,
      description: "Path to the file that exports a FragnoDatabase instance",
    },
  },
  run: info,
};

// Create a Map of db sub-commands
const dbSubCommands = new Map();
dbSubCommands.set("generate", generateCommand);
dbSubCommands.set("migrate", migrateCommand);
dbSubCommands.set("info", infoCommand);

// Helper function to print db command help
function printDbHelp() {
  console.log("Database management commands for Fragno");
  console.log("");
  console.log("Usage: @fragno-dev/cli db <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  generate    Generate schema files from FragnoDatabase definitions");
  console.log("  migrate     Run database migrations");
  console.log("  info        Display database information and migration status");
  console.log("");
  console.log("Run '@fragno-dev/cli db <command> --help' for more information.");
}

// Define the db command
export const dbCommand: Command = {
  name: "db",
  description: "Database management commands",
  run: printDbHelp,
};

// Create a Map of root sub-commands
const rootSubCommands = new Map();
rootSubCommands.set("db", dbCommand);

// Define the main command
export const mainCommand: Command = {
  name: "@fragno-dev/cli",
  description: "Fragno CLI - Tools for working with Fragno fragments",
  run: () => {
    console.log("Fragno CLI - Tools for working with Fragno fragments");
    console.log("");
    console.log("Usage: @fragno-dev/cli <command> [options]");
    console.log("");
    console.log("Commands:");
    console.log("  db    Database management commands");
    console.log("");
    console.log("Run '@fragno-dev/cli <command> --help' for more information.");
  },
};

if (import.meta.main) {
  try {
    // Parse arguments to handle nested subcommands
    const args = process.argv.slice(2);

    // Check if we're calling a db subcommand directly
    if (args[0] === "db" && args.length > 1) {
      const subCommandName = args[1];

      // Check if it's a help request
      if (subCommandName === "--help" || subCommandName === "-h") {
        printDbHelp();
        process.exit(0);
      }

      const subCommand = dbSubCommands.get(subCommandName);

      if (!subCommand) {
        console.error(`Unknown command: ${subCommandName}`);
        console.log("");
        printDbHelp();
        process.exit(1);
      }

      // Run the specific subcommand with its args
      const subArgs = args.slice(2);
      const isSubCommandHelp = subArgs.includes("--help") || subArgs.includes("-h");

      // Check for validation errors before running
      let hasValidationError = false;
      if (!isSubCommandHelp && subCommand.args) {
        const tokens = parseArgs(subArgs);
        const resolved = resolveArgs(subCommand.args, tokens);
        hasValidationError = !!resolved.error;
      }

      // Run the command (let gunshi handle printing errors/help)
      await cli(subArgs, subCommand);

      // Exit with error code if there was a validation error
      if (hasValidationError) {
        process.exit(1);
      }
    } else if (args[0] === "db") {
      // "db" command with no subcommand - show db help
      printDbHelp();
    } else {
      // Run the main CLI
      await cli(args, mainCommand, {
        subCommands: rootSubCommands,
      });
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
