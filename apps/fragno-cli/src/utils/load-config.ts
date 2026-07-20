import { constants } from "node:fs";
import { readFile, access } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";

import { loadConfig as c12LoadConfig } from "c12";
import { stripComments } from "jsonc-parser";

/**
 * Checks if a file exists using async API.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walks up the directory tree from the target path to find a tsconfig.json file.
 */
async function findTsconfig(startPath: string): Promise<string | null> {
  let currentDir = dirname(startPath);
  const root = resolve("/");

  while (currentDir !== root) {
    const tsconfigPath = join(currentDir, "tsconfig.json");
    if (await fileExists(tsconfigPath)) {
      return tsconfigPath;
    }
    currentDir = dirname(currentDir);
  }

  return null;
}

/**
 * Strips comments from JSONC (JSON with Comments) content.
 */
export function stripJsonComments(jsonc: string): string {
  return stripComments(jsonc);
}

/**
 * Converts TypeScript path aliases to jiti alias format.
 * Strips trailing '*' from aliases and paths, and resolves paths relative to baseUrl.
 */
export function convertTsconfigPathsToJitiAlias(
  tsconfigPaths: Record<string, string[]>,
  baseUrlResolved: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tsconfigPaths).map(([_alias, paths]) => {
      const pathsArray = paths;
      // trim '*' if present and resolve the actual path
      const aliasKey = _alias.endsWith("*") ? _alias.slice(0, -1) : _alias;
      const pathValue = pathsArray[0].endsWith("*") ? pathsArray[0].slice(0, -1) : pathsArray[0];
      return [aliasKey, resolve(baseUrlResolved, pathValue)];
    }),
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseCompilerOptions = (
  value: unknown,
): { baseUrl?: unknown; paths?: unknown } | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new TypeError("compilerOptions must be an object");
  }

  const { baseUrl, paths } = value;
  return { baseUrl, paths };
};

const parseTsconfigPaths = (value: unknown): Record<string, string[]> | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new TypeError("compilerOptions.paths must be an object");
  }

  const paths: Record<string, string[]> = {};
  for (const [alias, targets] of Object.entries(value)) {
    if (!Array.isArray(targets) || targets.length === 0) {
      throw new TypeError(`compilerOptions.paths['${alias}'] must be a non-empty array`);
    }
    if (targets.some((target) => typeof target !== "string")) {
      throw new TypeError(`compilerOptions.paths['${alias}'] must contain only strings`);
    }
    paths[alias] = targets;
  }
  return paths;
};

/**
 * Resolves tsconfig path aliases for use with jiti.
 */
async function resolveTsconfigAliases(targetPath: string): Promise<Record<string, string>> {
  const tsconfigPath = await findTsconfig(targetPath);

  if (!tsconfigPath) {
    return {};
  }

  try {
    const tsconfigContent = await readFile(tsconfigPath, "utf-8");
    const jsonContent = stripJsonComments(tsconfigContent);
    const parsed: unknown = JSON.parse(jsonContent);
    if (!isRecord(parsed)) {
      throw new TypeError("tsconfig root must be an object");
    }

    const { compilerOptions: rawCompilerOptions } = parsed;
    const compilerOptions = parseCompilerOptions(rawCompilerOptions);
    if (!compilerOptions) {
      return {};
    }

    const tsconfigPaths = parseTsconfigPaths(compilerOptions.paths);
    if (!tsconfigPaths) {
      return {};
    }

    const configuredBaseUrl = compilerOptions.baseUrl;
    if (configuredBaseUrl !== undefined && typeof configuredBaseUrl !== "string") {
      throw new TypeError("compilerOptions.baseUrl must be a string");
    }
    const baseUrlResolved = resolve(dirname(tsconfigPath), configuredBaseUrl ?? ".");

    return convertTsconfigPathsToJitiAlias(tsconfigPaths, baseUrlResolved);
  } catch (error) {
    throw new Error(`Failed to resolve TypeScript path aliases from ${tsconfigPath}`, {
      cause: error,
    });
  }
}

/**
 * Loads a config file using c12 with automatic tsconfig path alias resolution.
 */
export async function loadConfig(path: string): Promise<Record<string, unknown>> {
  const alias = await resolveTsconfigAliases(path);

  const { config } = await c12LoadConfig({
    configFile: path,
    jitiOptions: {
      alias,
    },
  });

  return config as Record<string, unknown>;
}
