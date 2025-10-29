#!/usr/bin/env node

import { cli, type Command } from "gunshi";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import { toNodeHandler } from "@fragno-dev/node";
import { pgFolder } from "./database";
import { userCommand, userSubCommands } from "./commands/user";
import { postCommand, postSubCommands } from "./commands/post";
import { commentCommand, commentSubCommands } from "./commands/comment";
import { ratingCommand, ratingSubCommands } from "./commands/rating";
import { relationsCommand, relationsSubCommands } from "./commands/relations";
import { fragment } from "./fragno/auth-fragment";

// Clean command
const cleanCommand: Command = {
  name: "clean",
  description: "Clean the database folder",
  run: async () => {
    rmSync(pgFolder, { recursive: true, force: true });
    console.log("Database cleaned successfully.");
  },
};

// Serve command
const serveCommand: Command = {
  name: "serve",
  description: "Start a web server with auth fragment routes",
  run: async () => {
    const port = 3000;
    const server = createServer(toNodeHandler(fragment.handler));

    server.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
      console.log(`Auth fragment mounted at ${fragment.mountRoute}`);
    });
  },
};

// Root commands
export const rootSubCommands = new Map();
rootSubCommands.set("clean", cleanCommand);
rootSubCommands.set("serve", serveCommand);
rootSubCommands.set("user", userCommand);
rootSubCommands.set("post", postCommand);
rootSubCommands.set("comment", commentCommand);
rootSubCommands.set("rating", ratingCommand);
rootSubCommands.set("relations", relationsCommand);

export const mainCommand: Command = {
  name: "fragno-db-usage-drizzle",
  description: "CLI for CRUD operations on users, blog posts, and comments",
  run: () => {
    console.log("Fragno DB Usage CLI");
    console.log("");
    console.log("Usage: node --import tsx src/mod.ts <command> [options]");
    console.log("");
    console.log("Commands:");
    console.log("  clean      Clean the database folder");
    console.log("  serve      Start a web server with auth fragment routes");
    console.log("  user       User management commands");
    console.log("  post       Blog post management commands");
    console.log("  comment    Comment management commands");
    console.log("  rating     Rating/upvote management commands");
    console.log("  relations  Test relational query commands");
    console.log("");
    console.log("Run 'node --import tsx src/mod.ts <command> --help' for more information.");
  },
};

if (import.meta.main) {
  const args = process.argv.slice(2);

  // Check if we're calling subcommands
  if (args[0] === "comment" && args.length > 1 && args[1] !== "--help" && args[1] !== "-h") {
    await cli(args.slice(1), commentCommand, {
      subCommands: commentSubCommands,
    });
  } else if (args[0] === "user" && args.length > 1 && args[1] !== "--help" && args[1] !== "-h") {
    await cli(args.slice(1), userCommand, {
      subCommands: userSubCommands,
    });
  } else if (args[0] === "post" && args.length > 1 && args[1] !== "--help" && args[1] !== "-h") {
    await cli(args.slice(1), postCommand, {
      subCommands: postSubCommands,
    });
  } else if (args[0] === "rating" && args.length > 1 && args[1] !== "--help" && args[1] !== "-h") {
    await cli(args.slice(1), ratingCommand, {
      subCommands: ratingSubCommands,
    });
  } else if (
    args[0] === "relations" &&
    args.length > 1 &&
    args[1] !== "--help" &&
    args[1] !== "-h"
  ) {
    await cli(args.slice(1), relationsCommand, {
      subCommands: relationsSubCommands,
    });
  } else {
    await cli(args, mainCommand, {
      subCommands: rootSubCommands,
    });
  }
}
