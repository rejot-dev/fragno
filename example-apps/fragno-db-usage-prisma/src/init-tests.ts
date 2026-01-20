import { cli, parseArgs, resolveArgs } from "gunshi";
import { migrateCommand } from "@fragno-dev/cli";
import { rm } from "node:fs/promises";
import { execSync } from "node:child_process";
import { dbFile } from "./constants";

export default async function setup() {
  console.log("Setting up test environment...");

  // Clean database file
  await rm(dbFile, { force: true });

  // Ensure Prisma client is generated before using it in tests
  execSync("pnpm exec prisma generate --schema ./prisma/schema.prisma", {
    stdio: "inherit",
  });

  // Create user and blog_post tables
  execSync("pnpm exec prisma db push --schema ./prisma/schema.prisma", {
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

await setup();
