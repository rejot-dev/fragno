import { resolve } from "node:path";
import { define } from "gunshi";
import { importFragmentFiles } from "../../utils/find-fragno-databases";
import { executeMigrations, type ExecuteMigrationResult } from "@fragno-dev/db/generation-engine";

export const migrateCommand = define({
  name: "migrate",
  description: "Run database migrations for all fragments to their latest versions",
  args: {},
  run: async (ctx) => {
    const targets = ctx.positionals;

    if (targets.length === 0) {
      throw new Error("At least one target file path is required");
    }

    // Resolve all target paths
    const targetPaths = targets.map((target) => resolve(process.cwd(), target));

    // Import all fragment files and validate they use the same adapter
    const { databases: allFragnoDatabases } = await importFragmentFiles(targetPaths);

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

    for (const db of allFragnoDatabases) {
      await db.adapter.close();
    }

    console.log("\n✓ All migrations completed successfully");
  },
});
