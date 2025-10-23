import { resolve } from "node:path";
import { define } from "gunshi";
import { findFragnoDatabases } from "../../utils/find-fragno-databases";

export const migrateCommand = define({
  name: "migrate",
  description: "Run database migrations",
  args: {
    from: {
      type: "number",
      short: "f",
      description: "Expected current database version (validates before migrating)",
    },
    to: {
      type: "number",
      short: "t",
      description: "Target version to migrate to (default: latest schema version)",
    },
  },
  run: async (ctx) => {
    const target = ctx.positionals[0];
    const version = ctx.values.to;
    const fromVersion = ctx.values.from;

    if (!target) {
      throw new Error("Target file path is required");
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

    // Find all FragnoDatabase instances or instantiated fragments with databases
    const fragnoDatabases = findFragnoDatabases(targetModule);

    if (fragnoDatabases.length === 0) {
      throw new Error(
        `No FragnoDatabase instances found in ${target}.\n` +
          `Make sure you export either:\n` +
          `  - A FragnoDatabase instance created with .create(adapter)\n` +
          `  - An instantiated fragment with embedded database definition\n`,
      );
    }

    if (fragnoDatabases.length > 1) {
      console.warn(
        `Warning: Multiple FragnoDatabase instances found (${fragnoDatabases.length}). Using the first one.`,
      );
    }

    // Use the first FragnoDatabase instance
    const fragnoDb = fragnoDatabases[0];

    console.log(`Migrating database for namespace: ${fragnoDb.namespace}`);

    // Check if the adapter supports migrations
    if (!fragnoDb.adapter.createMigrationEngine) {
      throw new Error(
        `Adapter does not support running migrations. The adapter only supports schema generation.\n` +
          `Try using 'fragno db generate' instead to generate schema files.`,
      );
    }

    // Run migrations
    let didMigrate: boolean;
    try {
      if (version !== undefined) {
        console.log(`Migrating to version ${version}...`);
        const migrator = fragnoDb.adapter.createMigrationEngine(
          fragnoDb.schema,
          fragnoDb.namespace,
        );
        const currentVersion = await migrator.getVersion();
        console.log(`Current version: ${currentVersion}`);

        // Validate from version if provided
        if (fromVersion !== undefined && currentVersion !== fromVersion) {
          throw new Error(
            `Current database version (${currentVersion}) does not match expected --from version (${fromVersion})`,
          );
        }

        const preparedMigration = await migrator.prepareMigrationTo(version, {
          updateSettings: true,
        });

        if (preparedMigration.operations.length === 0) {
          console.log("✓ Database is already at the target version. No migrations needed.");
          didMigrate = false;
        } else {
          await preparedMigration.execute();
          didMigrate = true;
        }
      } else {
        console.log(`Migrating to latest version (${fragnoDb.schema.version})...`);
        didMigrate = await fragnoDb.runMigrations();
      }
    } catch (error) {
      throw new Error(
        `Failed to run migrations: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (didMigrate) {
      console.log(`✓ Migration completed successfully`);
      console.log(`  Namespace: ${fragnoDb.namespace}`);
      if (version !== undefined) {
        console.log(`  New version: ${version}`);
      } else {
        console.log(`  New version: ${fragnoDb.schema.version}`);
      }
    }
  },
});
