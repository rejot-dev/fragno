import { cli, parseArgs, resolveArgs } from "gunshi";
import { generateCommand } from "@fragno-dev/cli";
import { rm, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";

// Inline the pgFolder constant to avoid importing from database.ts
const pgFolder = "./fragno-db-usage.pglite" as const;
const schemaOut = "./src/schema/fragno-schema.ts" as const;

export default async function setup() {
  console.log("Setting up test environment...");

  // Clean database and schema files
  await rm(pgFolder, { recursive: true, force: true });
  await rm(schemaOut, { force: true });

  // Create dummy schema file so imports don't fail during generation
  await writeFile(
    schemaOut,
    `// Temporary dummy exports
export const fragno_db_rating_db_schema = {};
export const fragno_db_comment_db_schema = {};
export const simple_auth_db_schema = {};\n`,
  );

  // Generate schema from fragment
  const args = [
    "src/fragno/comment-fragment.ts",
    "src/fragno/rating-fragment.ts",
    "src/fragno/auth-fragment.ts",
    "-o",
    schemaOut,
  ];

  if (generateCommand.args) {
    const tokens = parseArgs(args);
    const resolved = resolveArgs(generateCommand.args, tokens);

    if (resolved.error) {
      throw new Error(`Invalid arguments for generate command: ${resolved.error}`);
    }
  }

  await cli(args, generateCommand);

  // Run drizzle-kit push to apply migrations
  const migrateOutput = execSync("pnpm exec drizzle-kit push --config ./drizzle.config.ts", {
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
