import { cli, parseArgs, resolveArgs } from "gunshi";
import { migrateCommand } from "@fragno-dev/cli";
import { rm } from "node:fs/promises";
import { execSync } from "node:child_process";

// Inline the pgFolder constant to avoid importing from database.ts
const pgFolder = "./fragno-db-usage.pglite" as const;

export default async function setup() {
  console.log("Setting up test environment...");

  // Clean database folder
  await rm(pgFolder, { recursive: true, force: true });

  // Run kysely migrations for user and blog_post tables
  execSync("bunx kysely migrate up --config ./kysely.config.ts", {
    stdio: "inherit",
  });

  // Run Fragno migrations for the comment and rating fragments
  const args = ["src/fragno/comment-fragment.ts", "src/fragno/rating-fragment.ts"];

  // Validate arguments before running
  if (migrateCommand.args) {
    const tokens = parseArgs(args);
    const resolved = resolveArgs(migrateCommand.args, tokens);

    if (resolved.error) {
      throw new Error(`Invalid arguments for migrate command: ${resolved.error}`);
    }
  }

  await cli(args, migrateCommand);

  console.log("Test environment setup complete!");
}

if (import.meta.main) {
  await setup();
}
