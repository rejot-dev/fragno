import { resolve } from "node:path";
import { define } from "gunshi";
import { importFragmentFiles } from "../../utils/find-fragno-databases";

export const infoCommand = define({
  name: "info",
  description: "Display database information and migration status",
  args: {},
  run: async (ctx) => {
    const targets = ctx.positionals;

    if (targets.length === 0) {
      throw new Error("At least one target file path is required");
    }

    // Resolve all target paths
    const targetPaths = targets.map((target) => resolve(process.cwd(), target));

    // Import all fragment files
    const { databases: allFragnoDatabases } = await importFragmentFiles(targetPaths);

    // Collect database information
    const dbInfos = await Promise.all(
      allFragnoDatabases.map(async (fragnoDb) => {
        const info: {
          namespace: string;
          schemaVersion: number;
          migrationSupport: boolean;
          currentVersion?: number;
          pendingVersions?: number;
          status?: string;
          error?: string;
        } = {
          namespace: fragnoDb.namespace,
          schemaVersion: fragnoDb.schema.version,
          migrationSupport: !!fragnoDb.adapter.createMigrationEngine,
        };

        // Get current database version if migrations are supported
        if (fragnoDb.adapter.createMigrationEngine) {
          try {
            const migrator = fragnoDb.adapter.createMigrationEngine(
              fragnoDb.schema,
              fragnoDb.namespace,
            );
            const currentVersion = await migrator.getVersion();
            info.currentVersion = currentVersion;
            info.pendingVersions = fragnoDb.schema.version - currentVersion;

            if (info.pendingVersions > 0) {
              info.status = `Pending (${info.pendingVersions} migration(s))`;
            } else if (info.pendingVersions === 0) {
              info.status = "Up to date";
            }
          } catch (error) {
            info.error = error instanceof Error ? error.message : String(error);
            info.status = "Error";
          }
        } else {
          info.status = "Schema only";
        }

        return info;
      }),
    );

    // Determine if any database supports migrations
    const hasMigrationSupport = dbInfos.some((info) => info.migrationSupport);

    // Print compact table
    console.log("");
    console.log(`Database Information:`);
    console.log("");

    // Table header
    const namespaceHeader = "Namespace";
    const versionHeader = "Schema";
    const currentHeader = "Current";
    const statusHeader = "Status";

    const maxNamespaceLen = Math.max(
      namespaceHeader.length,
      ...dbInfos.map((info) => info.namespace.length),
    );
    const namespaceWidth = Math.max(maxNamespaceLen + 2, 20);
    const versionWidth = 8;
    const currentWidth = 9;
    const statusWidth = 25;

    // Print table
    console.log(
      namespaceHeader.padEnd(namespaceWidth) +
        versionHeader.padEnd(versionWidth) +
        (hasMigrationSupport ? currentHeader.padEnd(currentWidth) : "") +
        statusHeader,
    );
    console.log(
      "-".repeat(namespaceWidth) +
        "-".repeat(versionWidth) +
        (hasMigrationSupport ? "-".repeat(currentWidth) : "") +
        "-".repeat(statusWidth),
    );

    for (const info of dbInfos) {
      const currentVersionStr =
        info.currentVersion !== undefined ? String(info.currentVersion) : "-";
      console.log(
        info.namespace.padEnd(namespaceWidth) +
          String(info.schemaVersion).padEnd(versionWidth) +
          (hasMigrationSupport ? currentVersionStr.padEnd(currentWidth) : "") +
          (info.status || "-"),
      );
    }

    // Print help text
    console.log("");
    if (!hasMigrationSupport) {
      console.log("Note: These adapters do not support migrations.");
      console.log("Use 'fragno-cli db generate' to generate schema files.");
    } else {
      const hasPendingMigrations = dbInfos.some(
        (info) => info.pendingVersions && info.pendingVersions > 0,
      );
      if (hasPendingMigrations) {
        console.log("Run 'fragno-cli db migrate <target>' to apply pending migrations.");
      }
    }
  },
});
