#!/usr/bin/env bun

import { $ } from "bun";
import { join } from "node:path";
import { getNonPrivatePackages } from "./util/workspace-utils";

interface PackageToPublish {
  name: string;
  path: string;
  version: string;
}

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
1. Finds all non-private packages in the workspace
2. Publishes each non-private package using 'bun publish' in the correct directory

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
    // Get all non-private packages
    console.log("📊 Finding non-private packages...");
    const nonPrivatePackages = getNonPrivatePackages();

    if (nonPrivatePackages.length === 0) {
      console.log("📦 No non-private packages found to publish!");
      return;
    }

    // Get version information for each package
    const packagesToPublish: PackageToPublish[] = [];
    for (const pkg of nonPrivatePackages) {
      if (!pkg.pkgData.version) {
        console.log(`Skipping ${pkg.pkgData.name} - no version in package.json`);
        continue;
      }

      packagesToPublish.push({
        name: pkg.pkgData.name,
        path: pkg.path,
        version: pkg.pkgData.version,
      });
    }

    console.log("✅ Found non-private packages\n");

    console.log(`📦 Found ${packagesToPublish.length} non-private package(s) to publish:`);
    packagesToPublish.forEach((pkg) => {
      console.log(`  - ${pkg.name}@${pkg.version}`);
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
  pkg: PackageToPublish,
  isDryRun: boolean,
  access: string,
  tag: string,
) {
  console.log(`📤 Publishing ${pkg.name}...`);

  try {
    // Use the package path directly
    const packageDir = join(process.cwd(), pkg.path);

    console.log(`   📁 Publishing from: ${packageDir}`);

    // Build the publish command with flags
    const publishCommand = `bun publish --access ${access} --tag ${tag}`;

    if (isDryRun) {
      console.log(`   🧪 DRY RUN: Would publish ${pkg.name}@${pkg.version}`);
      console.log(`   🧪 DRY RUN: Command would be: cd ${packageDir} && ${publishCommand}`);
    } else {
      // Change to package directory and publish
      const result = await $`cd ${packageDir} && ${publishCommand}`.quiet();

      if (result.exitCode === 0) {
        console.log(`   ✅ Successfully published ${pkg.name}@${pkg.version} with tag "${tag}"`);
      } else {
        console.error(
          `   ❌ Failed to publish ${pkg.name}. This might be because the package is already published.`,
        );
        console.error(`   📄 stdout: ${result.stdout.toString()}`);
        console.error(`   📄 stderr: ${result.stderr.toString()}`);
      }
    }
  } catch (error) {
    console.error(`   ❌ Error publishing ${pkg.name}:`, error);
  }

  console.log();
}

// Run the main function
main().catch((error) => {
  console.error("💥 Unexpected error:", error);
  process.exit(1);
});
