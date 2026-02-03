import { cli, parseArgs, resolveArgs } from "gunshi";
import { generateCommand } from "@fragno-dev/cli";
import { rm, writeFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createRequire } from "node:module";

// Inline the pgFolder constant to avoid importing from database.ts
const pgFolder = "./fragno-db-usage.pglite" as const;
const schemaOut = "./src/schema/fragno-schema.ts" as const;

const require = createRequire(import.meta.url);
const { generateDrizzleJson, generateMigration } =
  require("drizzle-kit/api") as typeof import("drizzle-kit/api");

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
export const simple_auth_db_schema = {};
export const workflows_db_schema = {};\n`,
  );

  // Generate schema from fragment
  const args = [
    "src/fragno/comment-fragment.ts",
    "src/fragno/rating-fragment.ts",
    "src/fragno/auth-fragment.ts",
    "src/fragno/workflows-fragment.ts",
    "--format",
    "drizzle",
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

  // Ensure non-public schemas exist before pushing migrations.
  const client = new PGlite(pgFolder);
  await client.query('create schema if not exists "comment";');
  await client.query('create schema if not exists "upvote";');
  await client.query('create schema if not exists "auth";');
  await client.query('create schema if not exists "workflows";');

  const [drizzleModule, fragnoModule] = await Promise.all([
    import("./schema/drizzle-schema.ts"),
    import("./schema/fragno-schema.ts"),
  ]);
  const schemaModule = { ...drizzleModule, ...fragnoModule };
  const schemaFilters = ["public", "comment", "upvote", "auth", "workflows"];
  const migrationStatements = await generateMigration(
    generateDrizzleJson({}, undefined, schemaFilters),
    generateDrizzleJson(schemaModule, undefined, schemaFilters),
  );
  for (const statement of migrationStatements) {
    const trimmed = statement.trim();
    if (!trimmed) {
      continue;
    }
    await client.query(trimmed);
  }
  await client.syncToFs();
  await client.close();

  console.log("Test environment setup complete!");
}

if (import.meta.main) {
  await setup();
}
