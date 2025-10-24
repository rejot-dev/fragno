import { execSync } from "node:child_process";
import { join, relative } from "node:path";

export type WorkspacePackage = {
  path: string;
  pkgData: PackageJson;
};

export type PackageJson = {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[];
  version?: string;
  private: boolean;
};

export function getAllWorkspacePackages(): WorkspacePackage[] {
  const output = execSync("pnpm list -r --only-projects --json", {
    encoding: "utf-8",
    cwd: process.cwd(),
  });

  const pnpmPackages = JSON.parse(output) as Array<{
    name: string;
    version?: string;
    path: string;
    private?: boolean;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    workspaces?: string[];
  }>;

  return pnpmPackages.map((pkg) => ({
    path: relative(process.cwd(), pkg.path),
    pkgData: {
      name: pkg.name,
      private: pkg.private ?? false,
      dependencies: pkg.dependencies,
      devDependencies: pkg.devDependencies,
      workspaces: pkg.workspaces,
      version: pkg.version,
    },
  }));
}

export function getNonPrivatePackages(): WorkspacePackage[] {
  const allPackages = getAllWorkspacePackages();
  return allPackages.filter((pkg) => {
    return !pkg.pkgData.private;
  });
}

export function findPackageDirectory(packageName: string): string | null {
  const workspacePackages = getAllWorkspacePackages();
  const packageInfo = workspacePackages.find((pkg) => pkg.pkgData.name === packageName);

  if (!packageInfo) {
    return null;
  }

  return join(process.cwd(), packageInfo.path);
}

if (import.meta.main) {
  console.log({
    getNonPrivatePackages: getNonPrivatePackages(),
    getAllWorkspacePackages: getAllWorkspacePackages(),
  });
}
