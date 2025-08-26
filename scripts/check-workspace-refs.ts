#!/usr/bin/env bun

import { $ } from "bun";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, relative } from "path";

import {
  checkTsConfigReferences,
  findWorkspaceReferences,
  parseWorkspacePackages,
  type WorkspacePackage,
} from "./workspace-utils";

export function updateTsConfig(
  tsConfigPath: string,
  missingRefs: string[],
  packages: WorkspacePackage[],
) {
  const tsConfig = JSON.parse(readFileSync(tsConfigPath, "utf-8"));

  if (!tsConfig.references) {
    tsConfig.references = [];
  }

  for (const ref of missingRefs) {
    const pkg = packages.find((p) => p.name === ref);
    if (!pkg) continue;

    const relativePath = relative(dirname(tsConfigPath), join(process.cwd(), pkg.path));

    tsConfig.references.push({ path: relativePath });
  }

  writeFileSync(tsConfigPath, JSON.stringify(tsConfig, null, 2) + "\n");
}

async function main() {
  try {
    const args = process.argv.slice(2);
    const shouldUpdate = args.includes("--update");
    let hasErrors = false;
    let hasUpdates = false;

    const result = await $`bun pm ls`.quiet();
    const packages = await parseWorkspacePackages(result.text());

    for (const pkg of packages) {
      const packageJsonPath = join(process.cwd(), pkg.path, "package.json");
      const tsConfigPath = join(process.cwd(), pkg.path, "tsconfig.json");

      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
      const workspaceRefs = findWorkspaceReferences(packageJson);

      if (workspaceRefs.length > 0 && existsSync(tsConfigPath)) {
        const missingRefs = checkTsConfigReferences(tsConfigPath, workspaceRefs, packages);

        if (missingRefs.length > 0) {
          console.log(`\n❌ ${relative(process.cwd(), tsConfigPath)}`);
          console.log(`   Missing references: ${missingRefs.join(", ")}`);

          if (shouldUpdate) {
            updateTsConfig(tsConfigPath, missingRefs, packages);
            console.log(`   Updated tsconfig.json with missing references`);
            hasUpdates = true;
          } else {
            hasErrors = true;
          }
        }
      }
    }

    process.exit(hasErrors || hasUpdates ? 1 : 0);
  } catch (error) {
    console.error(`Fatal error: `, error);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
} else {
  console.warn("This script is not meant to be imported");
}
