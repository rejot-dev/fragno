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
        const adapterMetadata = fragnoDb.adapter.adapterMetadata;
        const databaseType = adapterMetadata?.databaseType;
        const sqliteProfile = adapterMetadata?.sqliteProfile;
        const namespaceKey = fragnoDb.namespace ?? fragnoDb.schema.name;
        const displayNamespace = fragnoDb.namespace ?? "(none)";
        const info: {
          namespace: string;
          schemaVersion: number;
          migrationSupport: boolean;
          databaseType?: string;
          sqliteProfile?: string;
          currentVersion?: string;
          pendingVersions?: string;
          status?: string;
        } = {
          namespace: displayNamespace,
          schemaVersion: fragnoDb.schema.version,
          migrationSupport: !!fragnoDb.adapter.prepareMigrations,
          databaseType,
          sqliteProfile: databaseType === "sqlite" ? sqliteProfile : undefined,
        };

        // Get current database version if migrations are supported
        if (fragnoDb.adapter.prepareMigrations) {
          const currentVersion = await fragnoDb.adapter.getSchemaVersion(namespaceKey);
          info.currentVersion = currentVersion;
          // info.pendingVersions = fragnoDb.schema.version - currentVersion;

          if (info.schemaVersion.toString() !== info.currentVersion) {
            info.status = `Migrations pending`;
          } else {
            info.status = "Up to date";
          }
        } else {
          info.status = "Schema only";
        }

        return info;
      }),
    );

    const showDatabaseType = dbInfos.some((info) => !!info.databaseType);
    const showSqliteProfile = dbInfos.some((info) => info.databaseType === "sqlite");

    // Determine if any database supports migrations
    const hasMigrationSupport = dbInfos.some((info) => info.migrationSupport);

    // Print compact table
    console.log("");
    console.log(`Database Information:`);
    console.log("");

    // Table header
    const namespaceHeader = "Namespace";
    const versionHeader = "Schema";
    const databaseHeader = "DB";
    const profileHeader = "SQLite";
    const currentHeader = "Current";
    const statusHeader = "Status";

    const maxNamespaceLen = Math.max(
      namespaceHeader.length,
      ...dbInfos.map((info) => info.namespace.length),
    );
    const namespaceWidth = Math.max(maxNamespaceLen + 2, 20);
    const versionWidth = 8;
    const databaseWidth = 8;
    const profileWidth = 10;
    const currentWidth = 9;
    const statusWidth = 25;

    // Print table
    console.log(
      namespaceHeader.padEnd(namespaceWidth) +
        versionHeader.padEnd(versionWidth) +
        (showDatabaseType ? databaseHeader.padEnd(databaseWidth) : "") +
        (showSqliteProfile ? profileHeader.padEnd(profileWidth) : "") +
        (hasMigrationSupport ? currentHeader.padEnd(currentWidth) : "") +
        statusHeader,
    );
    console.log(
      "-".repeat(namespaceWidth) +
        "-".repeat(versionWidth) +
        (showDatabaseType ? "-".repeat(databaseWidth) : "") +
        (showSqliteProfile ? "-".repeat(profileWidth) : "") +
        (hasMigrationSupport ? "-".repeat(currentWidth) : "") +
        "-".repeat(statusWidth),
    );

    for (const info of dbInfos) {
      const currentVersionStr =
        info.currentVersion !== undefined ? String(info.currentVersion) : "-";
      console.log(
        info.namespace.padEnd(namespaceWidth) +
          String(info.schemaVersion).padEnd(versionWidth) +
          (showDatabaseType ? (info.databaseType ?? "-").padEnd(databaseWidth) : "") +
          (showSqliteProfile ? (info.sqliteProfile ?? "-").padEnd(profileWidth) : "") +
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
      console.log("Run 'fragno-cli db migrate <target>' to apply pending migrations.");
    }
  },
});
