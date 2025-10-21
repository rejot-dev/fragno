import { cli } from "gunshi";
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
  await cli(
    [
      "--target",
      "src/fragno/comment-fragment.ts",
      "-o",
      "src/schema/comment-fragment-schema.ts",
      "--prefix",
      "// @prettier-ignore",
    ],
    generateCommand,
  );

  // Run drizzle-kit push to apply migrations
  const migrateOutput = execSync("bunx drizzle-kit push --config ./drizzle.config.ts", {
    encoding: "utf-8",
  });

  if (!migrateOutput.includes("Changes applied")) {
    throw new Error("Failed to apply database migrations");
  }

  console.log("Test environment setup complete!");
}
