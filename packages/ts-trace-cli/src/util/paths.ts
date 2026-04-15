import { existsSync } from "node:fs";
import { dirname, isAbsolute, normalize, resolve } from "node:path";

export type NormalizedTracePath = {
  rawPath: string;
  normalizedPath: string;
  displayPath: string;
  repoRelativePath?: string;
  isWithinWorkspace: boolean;
  isNodeModules: boolean;
  isTypeScriptLib: boolean;
};

export type PathQuery =
  | {
      kind: "absolute";
      value: string;
    }
  | {
      kind: "relative";
      value: string;
    };

const toPosixPath = (value: string): string => value.replaceAll("\\", "/");

const normalizeForComparison = (value: string): string =>
  toPosixPath(normalize(value)).toLowerCase();

const stripLeadingCurrentDirectory = (value: string): string => value.replace(/^\.\//u, "");

export const findWorkspaceRoot = (startDir = process.cwd()): string => {
  let currentDir = resolve(startDir);

  while (true) {
    if (
      existsSync(resolve(currentDir, "pnpm-workspace.yaml")) ||
      existsSync(resolve(currentDir, ".git"))
    ) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return resolve(startDir);
    }

    currentDir = parentDir;
  }
};

export const resolveWorkspaceRoot = (workspaceRoot?: string): string =>
  workspaceRoot ? resolve(workspaceRoot) : findWorkspaceRoot();

export const normalizeTracePath = (
  rawPath: string,
  workspaceRoot = resolveWorkspaceRoot(),
): NormalizedTracePath => {
  const resolvedWorkspaceRoot = resolveWorkspaceRoot(workspaceRoot);
  const normalizedPath = toPosixPath(
    normalize(isAbsolute(rawPath) ? rawPath : resolve(resolvedWorkspaceRoot, rawPath)),
  );
  const normalizedWorkspaceRoot = toPosixPath(normalize(resolvedWorkspaceRoot));
  const pathKey = normalizedPath.toLowerCase();
  const workspaceKey = normalizedWorkspaceRoot.toLowerCase();
  const isWithinWorkspace = pathKey === workspaceKey || pathKey.startsWith(`${workspaceKey}/`);
  const repoRelativePath = isWithinWorkspace
    ? normalizedPath.slice(normalizedWorkspaceRoot.length + (pathKey === workspaceKey ? 0 : 1))
    : undefined;
  const displayPath = repoRelativePath ?? normalizedPath;
  const isNodeModules = /(^|\/)node_modules(\/|$)/u.test(displayPath);
  const isTypeScriptLib =
    /\/typescript\/lib\/lib\.[^/]+\.d\.ts$/iu.test(normalizedPath) ||
    (isNodeModules && /(^|\/)lib\.[^/]+\.d\.ts$/iu.test(displayPath));

  return {
    rawPath,
    normalizedPath,
    displayPath,
    repoRelativePath,
    isWithinWorkspace,
    isNodeModules,
    isTypeScriptLib,
  };
};

export const normalizePathQuery = (
  value: string,
  workspaceRoot = resolveWorkspaceRoot(),
): PathQuery => {
  if (isAbsolute(value)) {
    return {
      kind: "absolute",
      value: normalizeTracePath(value, workspaceRoot).normalizedPath,
    };
  }

  return {
    kind: "relative",
    value: toPosixPath(normalize(stripLeadingCurrentDirectory(value))),
  };
};

export const pathMatchesQuery = (path: NormalizedTracePath, query: PathQuery): boolean => {
  if (query.kind === "absolute") {
    return normalizeForComparison(path.normalizedPath) === normalizeForComparison(query.value);
  }

  if (!path.repoRelativePath) {
    return false;
  }

  return normalizeForComparison(path.repoRelativePath) === normalizeForComparison(query.value);
};
