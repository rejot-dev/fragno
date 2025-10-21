import { cli } from "gunshi";
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

  // Run Fragno migrations for the comment fragment
  await cli(["--target", "src/fragno/comment-fragment.ts"], migrateCommand);

  console.log("Test environment setup complete!");
}
