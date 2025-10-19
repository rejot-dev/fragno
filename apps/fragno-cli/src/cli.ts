#!/usr/bin/env node

import { cli, type Command } from "gunshi";
import { generate } from "./commands/db/generate.js";

// Define the db generate command
const generateCommand: Command = {
  name: "generate",
  description: "Generate schema files from FragnoDatabase definitions",
  args: {
    target: {
      type: "string" as const,
      description: "Path to the file that exports a FragnoDatabase instance",
      required: true as const,
    },
    output: {
      type: "string" as const,
      short: "o",
      description:
        "Output path for the generated schema file (default: schema.sql for Kysely, schema.ts for Drizzle)",
    },
  },
  run: generate,
};

// Create a Map of db sub-commands
const dbSubCommands = new Map();
dbSubCommands.set("generate", generateCommand);

// Define the db command
const dbCommand: Command = {
  name: "db",
  description: "Database management commands",
  run: () => {
    console.log("Database management commands for Fragno");
    console.log("");
    console.log("Usage: fragno db <command> [options]");
    console.log("");
    console.log("Commands:");
    console.log("  generate    Generate schema files from FragnoDatabase definitions");
    console.log("");
    console.log("Run 'fragno db <command> --help' for more information.");
  },
};

// Create a Map of root sub-commands
const rootSubCommands = new Map();
rootSubCommands.set("db", dbCommand);

// Define the main command
const mainCommand: Command = {
  name: "fragno",
  description: "Fragno CLI - Tools for working with Fragno fragments",
  run: () => {
    console.log("Fragno CLI - Tools for working with Fragno fragments");
    console.log("");
    console.log("Usage: fragno <command> [options]");
    console.log("");
    console.log("Commands:");
    console.log("  db    Database management commands");
    console.log("");
    console.log("Run 'fragno <command> --help' for more information.");
  },
};

// Parse arguments to handle nested subcommands
const args = process.argv.slice(2);

// Check if we're calling a db subcommand
if (args[0] === "db" && args.length > 1 && args[1] !== "--help" && args[1] !== "-h") {
  // Handle db subcommands
  await cli(args.slice(1), dbCommand, {
    subCommands: dbSubCommands,
  });
} else {
  // Run the main CLI
  await cli(args, mainCommand, {
    subCommands: rootSubCommands,
  });
}
