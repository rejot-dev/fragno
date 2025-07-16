#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, join, relative } from "path";

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

export type TsConfig = {
  references?: Array<{ path: string }>;
};

export async function parseWorkspacePackages(output: string): Promise<WorkspacePackage[]> {
  const packages: WorkspacePackage[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    const match = line.match(/@[^@]+@workspace:([^@]+)/);
    if (match) {
      const [_, path] = match;
      const packageJsonPath = join(process.cwd(), path, "package.json");
      if (existsSync(packageJsonPath)) {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
        packages.push({
          name: pkg.name,
          path: path,
          isWorkspace: true,
        });
      }
    }
  }

  return packages;
}

export function findWorkspaceReferences(pkg: PackageJson): string[] {
  const refs = new Set<string>();

  const checkDeps = (deps?: Record<string, string>) => {
    if (!deps) return;
    for (const [name, version] of Object.entries(deps)) {
      if (version === "*" || version.startsWith("workspace:")) {
        refs.add(name);
      }
    }
  };

  checkDeps(pkg.dependencies);
  checkDeps(pkg.devDependencies);

  return Array.from(refs);
}

export function checkTsConfigReferences(
  tsConfigPath: string,
  expectedRefs: string[],
  packages: WorkspacePackage[],
): string[] {
  if (!existsSync(tsConfigPath)) {
    return [];
  }

  const tsConfig = JSON.parse(readFileSync(tsConfigPath, "utf-8")) as TsConfig;
  const missingRefs: string[] = [];

  for (const ref of expectedRefs) {
    const pkg = packages.find((p) => p.name === ref);
    if (!pkg) continue;

    const relativePath = relative(dirname(tsConfigPath), join(process.cwd(), pkg.path));

    const hasRef = tsConfig.references?.some((r) => r.path === relativePath);
    if (!hasRef) {
      missingRefs.push(ref);
    }
  }

  return missingRefs;
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
