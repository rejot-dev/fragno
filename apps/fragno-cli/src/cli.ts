#!/usr/bin/env node

import { cli, type Command } from "gunshi";
import { generate } from "./commands/db/generate.js";
import { migrate } from "./commands/db/migrate.js";
import { info } from "./commands/db/info.js";

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
  },
  run: generate,
};

// Define the db migrate command
const migrateCommand: Command = {
  name: "migrate",
  description: "Run database migrations",
  args: {
    target: {
      type: "string" as const,
      description: "Path to the file that exports a FragnoDatabase instance",
      required: true as const,
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
const infoCommand: Command = {
  name: "info",
  description: "Display database information and migration status",
  args: {
    target: {
      type: "string" as const,
      description: "Path to the file that exports a FragnoDatabase instance",
      required: true as const,
    },
  },
  run: info,
};

// Create a Map of db sub-commands
const dbSubCommands = new Map();
dbSubCommands.set("generate", generateCommand);
dbSubCommands.set("migrate", migrateCommand);
dbSubCommands.set("info", infoCommand);

// Define the db command
const dbCommand: Command = {
  name: "db",
  description: "Database management commands",
  run: () => {
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
  },
};

// Create a Map of root sub-commands
const rootSubCommands = new Map();
rootSubCommands.set("db", dbCommand);

// Define the main command
const mainCommand: Command = {
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
