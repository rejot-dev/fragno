import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

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
  version?: string;
};

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

export function findPackageDirectory(packageName: string): string | null {
  const workspacePackages = getAllWorkspacePackages();
  const packageInfo = workspacePackages.find((pkg) => pkg.name === packageName);

  if (!packageInfo) {
    return null;
  }

  return join(process.cwd(), packageInfo.path);
}
