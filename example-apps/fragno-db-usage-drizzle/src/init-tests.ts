import { cli, parseArgs, resolveArgs } from "gunshi";
import { generateCommand } from "@fragno-dev/cli";
import { rm } from "node:fs/promises";
import { execSync } from "node:child_process";

// Inline the pgFolder constant to avoid importing from database.ts
const pgFolder = "./fragno-db-usage.pglite" as const;

export default async function setup() {
  console.log("Setting up test environment...");

  // Clean database and schema files
  await rm(pgFolder, { recursive: true, force: true });

  // Generate schema from fragment
  const args = [
    "src/fragno/comment-fragment.ts",
    "src/fragno/rating-fragment.ts",
    "-o",
    "src/schema/fragno-schema.ts",
    "--prefix",
    "// @prettier-ignore",
  ];

  // Validate arguments before running
  if (generateCommand.args) {
    const tokens = parseArgs(args);
    const resolved = resolveArgs(generateCommand.args, tokens);

    if (resolved.error) {
      throw new Error(`Invalid arguments for generate command: ${resolved.error}`);
    }
  }

  await cli(args, generateCommand);

  // Run drizzle-kit push to apply migrations
  const migrateOutput = execSync("bunx drizzle-kit push --config ./drizzle.config.ts", {
    encoding: "utf-8",
  });

  if (!migrateOutput.includes("Changes applied")) {
    throw new Error("Failed to apply database migrations");
  }

  console.log("Test environment setup complete!");
}

if (import.meta.main) {
  await setup();
}
