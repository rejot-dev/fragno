#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cli, define } from "gunshi";
import type { Args, Command } from "gunshi";

import { installationsCommand, installationsSubCommands } from "./commands/installations.js";
import { pullsCommand, pullsSubCommands } from "./commands/pulls.js";
import { repositoriesCommand, repositoriesSubCommands } from "./commands/repositories.js";
import { serveCommand } from "./commands/serve.js";
import { webhooksCommand, webhooksSubCommands } from "./commands/webhooks.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));
const version = packageJson.version as string;

const mainCommand = define({
  name: "fragno-github-app",
  description: "GitHub App fragment CLI",
});

const printMainHelp = () => {
  console.log("GitHub App fragment CLI");
  console.log("");
  console.log("USAGE:");
  console.log("  fragno-github-app <COMMAND>");
  console.log("");
  console.log("COMMANDS:");
  console.log("  serve                 Start a local fragment server");
  console.log("  installations         Installation commands");
  console.log("  repositories          Repository commands");
  console.log("  pulls                 Pull request commands");
  console.log("  webhooks              Webhook utilities");
  console.log("");
  console.log("CLIENT OPTIONS:");
  console.log("  -b, --base-url         Fragment base URL (env: FRAGNO_GITHUB_APP_BASE_URL)");
  console.log("  -H, --header           Extra HTTP header (repeatable)");
  console.log("  --timeout              Request timeout in ms (default: 15000)");
  console.log("  --retries              Retry count (default: 2)");
  console.log("  --retry-delay          Retry delay in ms (default: 500)");
  console.log("");
  console.log("SERVER ENV:");
  console.log("  GITHUB_APP_ID");
  console.log("  GITHUB_APP_SLUG");
  console.log("  GITHUB_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY_FILE)");
  console.log("  GITHUB_APP_WEBHOOK_SECRET");
  console.log("");
  console.log("EXAMPLES:");
  console.log("  fragno-github-app serve --port 6173 --db-path ./github-app.sqlite");
  console.log(
    "  fragno-github-app installations list -b http://localhost:6173/github-app-fragment",
  );
  console.log(
    "  fragno-github-app repositories linked -b http://localhost:6173/github-app-fragment",
  );
  console.log("");
};

const printServeHelp = () => {
  console.log("Serve command");
  console.log("");
  console.log("USAGE:");
  console.log("  fragno-github-app serve [options]");
  console.log("");
  console.log("OPTIONS:");
  console.log("  -H, --host             Host to bind to (default: 127.0.0.1)");
  console.log("  -p, --port             Port to listen on (default: 6173)");
  console.log("  --mount-route          Override mount route");
  console.log(
    "  --db-path              SQLite database path (default: ./github-app-fragment.sqlite)",
  );
  console.log("  --poll-interval        Durable hooks poll interval ms (default: 200)");
  console.log("");
  console.log("  --app-id               GitHub App ID (env: GITHUB_APP_ID)");
  console.log("  --app-slug             GitHub App slug (env: GITHUB_APP_SLUG)");
  console.log("  --private-key          GitHub App private key PEM (env: GITHUB_APP_PRIVATE_KEY)");
  console.log("  --private-key-file     GitHub App private key PEM file");
  console.log("  --webhook-secret       Webhook secret (env: GITHUB_APP_WEBHOOK_SECRET)");
  console.log("  --webhook-debug        Log webhook debug info (env: GITHUB_APP_WEBHOOK_DEBUG)");
  console.log("  --api-base-url         GitHub API base URL");
  console.log("  --api-version          GitHub API version");
  console.log("  --web-base-url         GitHub web base URL");
  console.log("  --default-link-key     Default link key");
  console.log("  --token-cache-ttl      Token cache TTL in seconds");
  console.log("");
};

const printInstallationsHelp = () => {
  console.log("Installation commands");
  console.log("");
  console.log("USAGE:");
  console.log("  fragno-github-app installations <COMMAND>");
  console.log("");
  console.log("COMMANDS:");
  console.log("  list                 List installations");
  console.log("  repos                List repositories for an installation");
  console.log("  sync                 Sync installation repositories from GitHub");
  console.log("");
};

const printRepositoriesHelp = () => {
  console.log("Repository commands");
  console.log("");
  console.log("USAGE:");
  console.log("  fragno-github-app repositories <COMMAND>");
  console.log("");
  console.log("COMMANDS:");
  console.log("  linked               List linked repositories");
  console.log("  link                 Link a repository");
  console.log("  unlink               Unlink a repository");
  console.log("");
};

const printPullsHelp = () => {
  console.log("Pull request commands");
  console.log("");
  console.log("USAGE:");
  console.log("  fragno-github-app pulls <COMMAND>");
  console.log("");
  console.log("COMMANDS:");
  console.log("  list                 List pull requests");
  console.log("  review               Create a pull request review");
  console.log("");
};

const printWebhooksHelp = () => {
  console.log("Webhook utilities");
  console.log("");
  console.log("USAGE:");
  console.log("  fragno-github-app webhooks <COMMAND>");
  console.log("");
  console.log("COMMANDS:");
  console.log("  send                 Send a signed webhook payload");
  console.log("");
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

  if (args[0] === "serve") {
    const next = args[1];
    if (!next || next === "--help" || next === "-h") {
      printServeHelp();
      return;
    }
    if (next === "--version" || next === "-v") {
      console.log(version);
      return;
    }

    await cli(args.slice(1), serveCommand as Command<Args>, {
      name: "fragno-github-app serve",
      version,
    });
    return;
  }

  if (args[0] === "installations") {
    const subCommandName = args[1];
    if (!subCommandName || subCommandName === "--help" || subCommandName === "-h") {
      printInstallationsHelp();
      return;
    }
    if (subCommandName === "--version" || subCommandName === "-v") {
      console.log(version);
      return;
    }

    const subCommand = installationsSubCommands.get(subCommandName);
    if (!subCommand) {
      console.error(`Unknown command: ${subCommandName}`);
      console.log("");
      console.log("Run 'fragno-github-app installations --help' for available commands.");
      process.exit(1);
    }

    await cli(args.slice(2), subCommand as Command<Args>, {
      name: `fragno-github-app installations ${subCommandName}`,
      version,
    });
    return;
  }

  if (args[0] === "repositories") {
    const subCommandName = args[1];
    if (!subCommandName || subCommandName === "--help" || subCommandName === "-h") {
      printRepositoriesHelp();
      return;
    }
    if (subCommandName === "--version" || subCommandName === "-v") {
      console.log(version);
      return;
    }

    const subCommand = repositoriesSubCommands.get(subCommandName);
    if (!subCommand) {
      console.error(`Unknown command: ${subCommandName}`);
      console.log("");
      console.log("Run 'fragno-github-app repositories --help' for available commands.");
      process.exit(1);
    }

    await cli(args.slice(2), subCommand as Command<Args>, {
      name: `fragno-github-app repositories ${subCommandName}`,
      version,
    });
    return;
  }

  if (args[0] === "pulls") {
    const subCommandName = args[1];
    if (!subCommandName || subCommandName === "--help" || subCommandName === "-h") {
      printPullsHelp();
      return;
    }
    if (subCommandName === "--version" || subCommandName === "-v") {
      console.log(version);
      return;
    }

    const subCommand = pullsSubCommands.get(subCommandName);
    if (!subCommand) {
      console.error(`Unknown command: ${subCommandName}`);
      console.log("");
      console.log("Run 'fragno-github-app pulls --help' for available commands.");
      process.exit(1);
    }

    await cli(args.slice(2), subCommand as Command<Args>, {
      name: `fragno-github-app pulls ${subCommandName}`,
      version,
    });
    return;
  }

  if (args[0] === "webhooks") {
    const subCommandName = args[1];
    if (!subCommandName || subCommandName === "--help" || subCommandName === "-h") {
      printWebhooksHelp();
      return;
    }
    if (subCommandName === "--version" || subCommandName === "-v") {
      console.log(version);
      return;
    }

    const subCommand = webhooksSubCommands.get(subCommandName);
    if (!subCommand) {
      console.error(`Unknown command: ${subCommandName}`);
      console.log("");
      console.log("Run 'fragno-github-app webhooks --help' for available commands.");
      process.exit(1);
    }

    await cli(args.slice(2), subCommand as Command<Args>, {
      name: `fragno-github-app webhooks ${subCommandName}`,
      version,
    });
    return;
  }

  if (args[0].startsWith("-")) {
    await cli(args, mainCommand as Command<Args>, {
      name: "fragno-github-app",
      version,
      subCommands: new Map([
        ["serve", serveCommand as Command<Args>],
        ["installations", installationsCommand as Command<Args>],
        ["repositories", repositoriesCommand as Command<Args>],
        ["pulls", pullsCommand as Command<Args>],
        ["webhooks", webhooksCommand as Command<Args>],
      ]),
    });
    return;
  }

  console.error(`Unknown command: ${args[0]}`);
  console.log("");
  console.log("Run 'fragno-github-app --help' for available commands.");
  process.exit(1);
}

if (import.meta.main) {
  await run();
}
