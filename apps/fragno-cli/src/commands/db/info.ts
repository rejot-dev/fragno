import { isFragnoDatabase, type FragnoDatabase } from "@fragno-dev/db";
import type { AnySchema } from "@fragno-dev/db/schema";
import { resolve } from "node:path";
import type { CommandContext } from "gunshi";

export async function info(ctx: CommandContext) {
  const target = ctx.values["target"];

  if (!target || typeof target !== "string") {
    throw new Error("Target file path is required and must be a string");
  }

  // Resolve the target file path relative to current working directory
  const targetPath = resolve(process.cwd(), target);

  console.log(`Loading target file: ${targetPath}`);

  // Dynamically import the target file
  let targetModule: Record<string, unknown>;
  try {
    targetModule = await import(targetPath);
  } catch (error) {
    throw new Error(
      `Failed to import target file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Find all FragnoDatabase instances in the exported values
  const fragnoDatabases: FragnoDatabase<AnySchema>[] = [];

  for (const [key, value] of Object.entries(targetModule)) {
    if (isFragnoDatabase(value)) {
      fragnoDatabases.push(value);
      console.log(`Found FragnoDatabase instance: ${key}`);
    }
  }

  if (fragnoDatabases.length === 0) {
    throw new Error(`No FragnoDatabase instances found in ${target}.\n`);
  }

  if (fragnoDatabases.length > 1) {
    console.warn(
      `Warning: Multiple FragnoDatabase instances found (${fragnoDatabases.length}). Using the first one.`,
    );
  }

  // Use the first FragnoDatabase instance
  const fragnoDb = fragnoDatabases[0];

  console.log("");
  console.log("Database Information");
  console.log("=".repeat(50));
  console.log(`Namespace: ${fragnoDb.namespace}`);
  console.log(`Latest Schema Version: ${fragnoDb.schema.version}`);

  // Check if the adapter supports migrations
  if (!fragnoDb.adapter.createMigrationEngine) {
    console.log(`Migration Support: No`);
    console.log("");
    console.log("Note: This adapter does not support running migrations.");
    console.log("Use 'fragno db generate' to generate schema files.");
    return;
  }

  console.log(`Migration Support: Yes`);

  // Get current database version
  try {
    const migrator = fragnoDb.adapter.createMigrationEngine(fragnoDb.schema, fragnoDb.namespace);
    const currentVersion = await migrator.getVersion();

    console.log(`Current Database Version: ${currentVersion}`);

    // Check if migrations are pending
    const pendingVersions = fragnoDb.schema.version - currentVersion;
    if (pendingVersions > 0) {
      console.log("");
      console.log(`⚠ Pending Migrations: ${pendingVersions} version(s) behind`);
      console.log(`  Run '@fragno-dev/cli db migrate --target ${target}' to update`);
    } else if (pendingVersions === 0) {
      console.log("");
      console.log(`✓ Database is up to date`);
    }
  } catch (error) {
    console.log("");
    console.log(
      `Warning: Could not retrieve current version: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  console.log("=".repeat(50));
}
