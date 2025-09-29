#!/usr/bin/env bun

import { $ } from "bun";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

interface ChangesetRelease {
  name: string;
  type: string;
  oldVersion?: string;
  newVersion?: string;
  changesets: string[];
}

interface ChangesetOutput {
  changesets: Array<{
    releases: Array<{
      name: string;
      type: string;
    }>;
    summary: string;
    id: string;
  }>;
  releases: ChangesetRelease[];
}

export type WorkspacePackage = {
  name: string;
  path: string;
  isWorkspace: boolean;
};

export type PackageJson = {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[];
};

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const showHelp = args.includes("--help") || args.includes("-h");

  // Parse access flag
  const accessIndex = args.indexOf("--access");
  const access = accessIndex !== -1 && args[accessIndex + 1] ? args[accessIndex + 1] : "private";

  // Parse tag flag
  const tagIndex = args.indexOf("--tag");
  const tag = tagIndex !== -1 && args[tagIndex + 1] ? args[tagIndex + 1] : "latest";

  if (showHelp) {
    console.log(`
📦 Fragno Package Publisher

Usage: bun scripts/src/publish-packages.ts [options]

Options:
  --dry-run              Show what would be published without actually publishing
  --access <public|private>  Set package access level (default: private)
  --tag <string>         Set package tag/dist-tag (default: latest)
  --help, -h             Show this help message

This script:
1. Runs 'bunx changeset status --output out.json' to get package updates
2. Parses the output to find packages with new versions
3. Publishes each updated package using 'bun publish' in the correct directory

Examples:
  bun scripts/src/publish-packages.ts --dry-run
  bun scripts/src/publish-packages.ts --access public --tag beta
  bun scripts/src/publish-packages.ts --tag next
`);
    return;
  }

  console.log("🚀 Starting package publishing process...");
  console.log(`📋 Configuration:`);
  console.log(`   Access: ${access}`);
  console.log(`   Tag: ${tag}`);
  if (isDryRun) {
    console.log("🧪 DRY RUN MODE - No packages will actually be published\n");
  } else {
    console.log();
  }

  try {
    // Run changeset status to get the output
    console.log("📊 Checking changeset status...");
    await $`bunx changeset status --output out.json`;

    // Read and parse the output
    const outputPath = join(process.cwd(), "out.json");
    const outputContent = readFileSync(outputPath, "utf-8");
    const changesetData: ChangesetOutput = JSON.parse(outputContent);

    console.log("✅ Changeset status retrieved\n");

    // Find packages that have new versions
    const packagesToPublish = changesetData.releases.filter(
      (release) => release.type !== "none" && release.newVersion,
    );

    if (packagesToPublish.length === 0) {
      console.log("📦 No packages to publish. All packages are up to date!");
      return;
    }

    console.log(`📦 Found ${packagesToPublish.length} package(s) to publish:`);
    packagesToPublish.forEach((pkg) => {
      console.log(`  - ${pkg.name}: ${pkg.oldVersion} → ${pkg.newVersion} (${pkg.type})`);
    });
    console.log();

    // Publish each package
    for (const pkg of packagesToPublish) {
      await publishPackage(pkg, isDryRun, access, tag);
    }

    if (isDryRun) {
      console.log("🎉 Dry run completed successfully!");
    } else {
      console.log("🎉 All packages published successfully!");
    }
  } catch (error) {
    console.error("❌ Error during publishing process:", error);
    process.exit(1);
  }
}

async function publishPackage(
  pkg: ChangesetRelease,
  isDryRun: boolean,
  access: string,
  tag: string,
) {
  console.log(`📤 Publishing ${pkg.name}...`);

  try {
    // Find the package directory
    const packageDir = findPackageDirectory(pkg.name);

    if (!packageDir) {
      console.error(`❌ Could not find directory for package ${pkg.name}`);
      return;
    }

    console.log(`   📁 Publishing from: ${packageDir}`);

    // Build the publish command with flags
    const publishCommand = `bun publish --access ${access} --tag ${tag}`;

    if (isDryRun) {
      console.log(`   🧪 DRY RUN: Would publish ${pkg.name}@${pkg.newVersion}`);
      console.log(`   🧪 DRY RUN: Command would be: cd ${packageDir} && ${publishCommand}`);
    } else {
      // Change to package directory and publish
      const result = await $`cd ${packageDir} && ${publishCommand}`.quiet();

      if (result.exitCode === 0) {
        console.log(`   ✅ Successfully published ${pkg.name}@${pkg.newVersion} with tag "${tag}"`);
      } else {
        console.error(`   ❌ Failed to publish ${pkg.name}`);
        console.error(`   📄 stdout: ${result.stdout.toString()}`);
        console.error(`   📄 stderr: ${result.stderr.toString()}`);
      }
    }
  } catch (error) {
    console.error(`   ❌ Error publishing ${pkg.name}:`, error);
  }

  console.log();
}

function findPackageDirectory(packageName: string): string | null {
  const workspacePackages = getAllWorkspacePackages();
  const packageInfo = workspacePackages.find((pkg) => pkg.name === packageName);

  if (!packageInfo) {
    return null;
  }

  return join(process.cwd(), packageInfo.path);
}

export function getAllWorkspacePackages(): WorkspacePackage[] {
  const packageJson = JSON.parse(
    readFileSync(join(process.cwd(), "package.json"), "utf-8"),
  ) as PackageJson;
  const workspaces = packageJson.workspaces || [];

  const packages: WorkspacePackage[] = [];
  for (const pattern of workspaces) {
    // Simple glob handling for basic patterns like "packages/*" and "apps/*"
    const [dir] = pattern.split("/*");
    if (existsSync(dir)) {
      const items = readdirSync(dir).filter((item) => existsSync(join(dir, item, "package.json")));

      for (const item of items) {
        const path = join(dir, item);
        const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf-8"));
        packages.push({
          name: pkg.name,
          path: relative(process.cwd(), path),
          isWorkspace: true,
        });
      }
    }
  }

  return packages;
}

// Run the main function
main().catch((error) => {
  console.error("💥 Unexpected error:", error);
  process.exit(1);
});
