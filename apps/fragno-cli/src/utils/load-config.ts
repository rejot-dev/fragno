import { loadConfig as c12LoadConfig } from "c12";
import { readFile, access } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { constants } from "node:fs";

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
  // Remove single-line comments (// ...)
  let result = jsonc.replace(/\/\/[^\n]*/g, "");

  // Remove multi-line comments (/* ... */)
  result = result.replace(/\/\*[\s\S]*?\*\//g, "");

  return result;
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
      const pathsArray = paths as string[];
      // trim '*' if present and resolve the actual path
      const aliasKey = _alias.endsWith("*") ? _alias.slice(0, -1) : _alias;
      const pathValue = pathsArray[0].endsWith("*") ? pathsArray[0].slice(0, -1) : pathsArray[0];
      return [aliasKey, resolve(baseUrlResolved, pathValue)];
    }),
  );
}

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
    // Strip comments to handle JSONC format
    const jsonContent = stripJsonComments(tsconfigContent);
    const tsconfig = JSON.parse(jsonContent);
    const tsconfigPaths = tsconfig?.compilerOptions?.paths;

    if (!tsconfigPaths || typeof tsconfigPaths !== "object") {
      return {};
    }

    const tsconfigDir = dirname(tsconfigPath);
    const baseUrl = tsconfig?.compilerOptions?.baseUrl || ".";
    const baseUrlResolved = resolve(tsconfigDir, baseUrl);

    // Convert tsconfig paths to jiti alias format
    return convertTsconfigPathsToJitiAlias(tsconfigPaths, baseUrlResolved);
  } catch (error) {
    console.warn(`Warning: Failed to parse tsconfig at ${tsconfigPath}:`, error);
    return {};
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
