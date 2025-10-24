import { resolve } from "node:path";
import { define } from "gunshi";
import { findFragnoDatabases } from "../../utils/find-fragno-databases";
import { type FragnoDatabase } from "@fragno-dev/db";
import { executeMigrations, type ExecuteMigrationResult } from "@fragno-dev/db/generation-engine";
import type { AnySchema } from "@fragno-dev/db/schema";

export const migrateCommand = define({
  name: "migrate",
  description: "Run database migrations for all fragments to their latest versions",
  args: {},
  run: async (ctx) => {
    const targets = ctx.positionals;

    if (targets.length === 0) {
      throw new Error("At least one target file path is required");
    }

    // De-duplicate targets
    const uniqueTargets = Array.from(new Set(targets));

    // Load all target files and collect FragnoDatabase instances
    const allFragnoDatabases: FragnoDatabase<AnySchema>[] = [];

    for (const target of uniqueTargets) {
      const targetPath = resolve(process.cwd(), target);
      console.log(`Loading target file: ${targetPath}`);

      // Dynamically import the target file
      let targetModule: Record<string, unknown>;
      try {
        targetModule = await import(targetPath);
      } catch (error) {
        throw new Error(
          `Failed to import target file ${target}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // Find all FragnoDatabase instances or instantiated fragments with databases
      const fragnoDatabases = findFragnoDatabases(targetModule);

      if (fragnoDatabases.length === 0) {
        console.warn(
          `Warning: No FragnoDatabase instances found in ${target}.\n` +
            `Make sure you export either:\n` +
            `  - A FragnoDatabase instance created with .create(adapter)\n` +
            `  - An instantiated fragment with embedded database definition\n`,
        );
        continue;
      }

      if (fragnoDatabases.length > 1) {
        console.warn(
          `Warning: Multiple FragnoDatabase instances found in ${target} (${fragnoDatabases.length}). Using all of them.`,
        );
      }

      allFragnoDatabases.push(...fragnoDatabases);
    }

    if (allFragnoDatabases.length === 0) {
      throw new Error(
        `No FragnoDatabase instances found in any of the target files.\n` +
          `Make sure your files export either:\n` +
          `  - A FragnoDatabase instance created with .create(adapter)\n` +
          `  - An instantiated fragment with embedded database definition\n`,
      );
    }

    console.log(
      `Found ${allFragnoDatabases.length} FragnoDatabase instance(s) across ${uniqueTargets.length} file(s)`,
    );

    // Validate all databases use the same adapter object (identity)
    const firstDb = allFragnoDatabases[0];
    const firstAdapter = firstDb.adapter;
    const allSameAdapter = allFragnoDatabases.every((db) => db.adapter === firstAdapter);

    if (!allSameAdapter) {
      throw new Error(
        "All fragments must use the same database adapter instance. Mixed adapters are not supported.",
      );
    }

    console.log("\nMigrating all fragments to their latest versions...\n");

    let results: ExecuteMigrationResult[];
    try {
      results = await executeMigrations(allFragnoDatabases);
    } catch (error) {
      throw new Error(
        `Migration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Display progress for each result
    for (const result of results) {
      console.log(`Fragment: ${result.namespace}`);
      console.log(`  Current version: ${result.fromVersion}`);
      console.log(`  Target version: ${result.toVersion}`);

      if (result.didMigrate) {
        console.log(`  ✓ Migration completed: v${result.fromVersion} → v${result.toVersion}\n`);
      } else {
        console.log(`  ✓ Already at latest version. No migration needed.\n`);
      }
    }

    // Summary
    console.log("═══════════════════════════════════════");
    console.log("Migration Summary");
    console.log("═══════════════════════════════════════");

    const migrated = results.filter((r) => r.didMigrate);
    const skipped = results.filter((r) => !r.didMigrate);

    if (migrated.length > 0) {
      console.log(`\n✓ Migrated ${migrated.length} fragment(s):`);
      for (const r of migrated) {
        console.log(`  - ${r.namespace}: v${r.fromVersion} → v${r.toVersion}`);
      }
    }

    if (skipped.length > 0) {
      console.log(`\n○ Skipped ${skipped.length} fragment(s) (already up-to-date):`);
      for (const r of skipped) {
        console.log(`  - ${r.namespace}: v${r.toVersion}`);
      }
    }

    console.log("\n✓ All migrations completed successfully");
  },
});
