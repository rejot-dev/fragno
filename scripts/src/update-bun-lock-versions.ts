#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAllWorkspacePackages, type PackageJson } from "./util/workspace-utils.js";
import JSONC from "jsonc-simple-parser";

type BunLockWorkspace = {
  name: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type BunLock = {
  lockfileVersion: number;
  workspaces: Record<string, BunLockWorkspace>;
};

function readPackageJson(packagePath: string): PackageJson {
  const packageJsonPath = join(packagePath, "package.json");
  if (!existsSync(packageJsonPath)) {
    throw new Error(`package.json not found at ${packageJsonPath}`);
  }
  return JSONC.parse(readFileSync(packageJsonPath, "utf-8")) as PackageJson;
}

function updateBunLockVersions(): void {
  const bunLockPath = join(process.cwd(), "bun.lock");

  if (!existsSync(bunLockPath)) {
    throw new Error("bun.lock not found in current directory");
  }

  const bunLockContent = readFileSync(bunLockPath, "utf-8");

  try {
    const bunLock = JSONC.parse(bunLockContent) as BunLock;

    // Get all workspace packages
    const workspacePackages = getAllWorkspacePackages();

    let updated = false;

    // Update versions for each workspace package
    for (const workspacePackage of workspacePackages) {
      const workspaceKey = workspacePackage.path || "";
      const workspaceEntry = bunLock.workspaces[workspaceKey];

      if (!workspaceEntry) {
        console.warn(
          `Workspace entry not found in bun.lock for: ${workspacePackage.name} (${workspaceKey})`,
        );
        continue;
      }

      // Read the package.json to get the version
      const packageJson = readPackageJson(workspacePackage.path);
      const expectedVersion = packageJson.version;

      if (!expectedVersion) {
        console.log(`Skipping ${workspacePackage.name} - no version in package.json`);
        continue;
      }

      // Check if version needs updating
      if (workspaceEntry.version !== expectedVersion) {
        console.log(
          `Updating version for ${workspacePackage.name}: ${workspaceEntry.version || "undefined"} -> ${expectedVersion}`,
        );
        workspaceEntry.version = expectedVersion;
        updated = true;
      }
    }

    // Also handle the root workspace (empty key)
    const rootWorkspace = bunLock.workspaces[""];
    if (rootWorkspace) {
      const rootPackageJson = readPackageJson(process.cwd());
      const rootVersion = rootPackageJson.version;

      if (rootVersion && rootWorkspace.version !== rootVersion) {
        console.log(
          `Updating root workspace version: ${rootWorkspace.version || "undefined"} -> ${rootVersion}`,
        );
        rootWorkspace.version = rootVersion;
        updated = true;
      }
    }

    if (updated) {
      // Write the updated bun.lock back to file
      writeFileSync(bunLockPath, JSON.stringify(bunLock, null, 2) + "\n");
      console.log("✅ bun.lock updated successfully");
    } else {
      console.log("✅ All workspace versions are already up to date");
    }
  } catch (error) {
    console.error("Failed to parse bun.lock as JSON:", error);
    console.error("First 500 characters of bun.lock:");
    console.error(bunLockContent.substring(0, 500));
    throw error;
  }
}

// Run the script
try {
  updateBunLockVersions();
} catch (error) {
  console.error("❌ Error updating bun.lock:", error);
  process.exit(1);
}
