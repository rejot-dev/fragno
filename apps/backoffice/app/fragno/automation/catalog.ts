import {
  createMasterFileSystem,
  normalizeRelativePath,
  type DirentEntry,
  type IFileSystem,
} from "@/files";
import { FileSystemError } from "@/files/fs-errors";

export const AUTOMATION_SYSTEM_ROOT = "/system/automations";
export const AUTOMATION_WORKSPACE_ROOT = "/workspace/automations";
export const AUTOMATION_SCRIPTS_ROOT = AUTOMATION_WORKSPACE_ROOT;
const AUTOMATION_ROOTS = [AUTOMATION_SYSTEM_ROOT, AUTOMATION_WORKSPACE_ROOT] as const;

export type AutomationFileSystemResolvePurpose = "route" | "runtime";

export type AutomationFileSystemResolverInput = {
  orgId?: string;
  purpose: AutomationFileSystemResolvePurpose;
};

export type AutomationFileSystemResolver = (
  input: AutomationFileSystemResolverInput,
) => Promise<IFileSystem> | IFileSystem;

export type AutomationFileSystemConfig = {
  automationFileSystem?: IFileSystem;
  getAutomationFileSystem?: AutomationFileSystemResolver;
};

export type AutomationScriptEngine = "bash" | "codemode";

type AutomationScriptMetadata = {
  id: string;
  key: string;
  name: string;
  engine: AutomationScriptEngine;
  path: string;
  absolutePath: string;
  version: number;
};

type AutomationScriptRuntimeState = {
  enabled: boolean;
};

type AutomationScriptSource = {
  body: string;
  scriptLoadError?: string | null;
};

export type AutomationScriptCatalogEntry = AutomationScriptMetadata &
  AutomationScriptSource &
  AutomationScriptRuntimeState;

export type AutomationBindingCatalogEntry = never;

export type AutomationCatalog = {
  version: 1;
  bindings: AutomationBindingCatalogEntry[];
  scripts: AutomationScriptCatalogEntry[];
};

export type AutomationScriptLayer = "system" | "workspace";

export type AutomationWorkspaceScriptEntry = {
  layer: AutomationScriptLayer;
  path: string;
  absolutePath: string;
  engine: AutomationScriptEngine;
  kind: "script" | "workflow";
};

const AUTOMATION_ROOT_RELATIVES = AUTOMATION_ROOTS.map((root) => root.slice(1));

const inferWorkspaceScriptEngine = (path: string): AutomationScriptEngine =>
  path.endsWith(".cm.js") ? "codemode" : "bash";

const normalizeScriptRelativePath = (value: string, label = "Automation script"): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} path is empty.`);
  }

  if (trimmed.startsWith("/")) {
    let normalizedAbsolutePath: string;
    try {
      normalizedAbsolutePath = normalizeRelativePath(trimmed.slice(1));
    } catch (error) {
      throw new Error(
        `${label} path '${value}' is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const matchedRoot = AUTOMATION_ROOT_RELATIVES.find(
      (root) => normalizedAbsolutePath === root || normalizedAbsolutePath.startsWith(`${root}/`),
    );
    if (!matchedRoot) {
      throw new Error(`${label} path '${value}' must stay under an automation root.`);
    }

    return normalizedAbsolutePath.slice(`${matchedRoot}/`.length);
  }

  try {
    return normalizeRelativePath(trimmed);
  } catch (error) {
    throw new Error(
      `${label} path '${value}' is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const toAbsoluteAutomationPath = (relativePath: string) =>
  `${AUTOMATION_WORKSPACE_ROOT}/${normalizeRelativePath(relativePath)}`;

const getAutomationRootForPath = (absolutePath: string) =>
  AUTOMATION_ROOTS.find((root) => absolutePath === root || absolutePath.startsWith(`${root}/`));

const toAutomationWorkspaceRelativePath = (absolutePath: string) => {
  const root = getAutomationRootForPath(absolutePath);
  if (!root) {
    throw new Error(`Automation path '${absolutePath}' must stay under an automation root.`);
  }

  return normalizeRelativePath(absolutePath.slice(`${root}/`.length));
};

const compareScriptEntries = <
  TScript extends Pick<AutomationScriptMetadata, "name" | "key" | "path">,
>(
  left: TScript,
  right: TScript,
) => {
  const nameOrder = left.name.localeCompare(right.name);
  if (nameOrder !== 0) {
    return nameOrder;
  }

  const keyOrder = left.key.localeCompare(right.key);
  if (keyOrder !== 0) {
    return keyOrder;
  }

  return left.path.localeCompare(right.path);
};

const compareWorkspaceScriptEntries = (
  left: AutomationWorkspaceScriptEntry,
  right: AutomationWorkspaceScriptEntry,
) => {
  const pathOrder = left.path.localeCompare(right.path);
  if (pathOrder !== 0) {
    return pathOrder;
  }

  return left.absolutePath.localeCompare(right.absolutePath);
};

const isAutomationWorkspaceDirectoryMissingError = (error: unknown): boolean => {
  if (error instanceof FileSystemError) {
    return error.code === "ENOENT";
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message === "Path not found." ||
    error.message === "File not found." ||
    error.message.startsWith("ENOENT:") ||
    error.message.endsWith(" was not found.")
  );
};

const listAutomationWorkspaceFilePaths = async (
  fileSystem: IFileSystem,
  absolutePath: string,
): Promise<string[]> => {
  let dirents: DirentEntry[] | null = null;

  if (fileSystem.readdirWithFileTypes) {
    try {
      dirents = await fileSystem.readdirWithFileTypes(absolutePath);
    } catch (error) {
      if (isAutomationWorkspaceDirectoryMissingError(error)) {
        return [];
      }

      throw error;
    }
  }

  if (!dirents) {
    let names: string[];
    try {
      names = await fileSystem.readdir(absolutePath);
    } catch (error) {
      if (isAutomationWorkspaceDirectoryMissingError(error)) {
        return [];
      }

      throw error;
    }

    dirents = names
      .slice()
      .sort((left, right) => left.localeCompare(right))
      .map(
        (name) =>
          ({
            name,
            isFile: false,
            isDirectory: false,
            isSymbolicLink: false,
          }) satisfies DirentEntry,
      );
  }

  const sortedDirents = dirents.slice().sort((left, right) => left.name.localeCompare(right.name));
  const paths = [] as string[];

  for (const entry of sortedDirents) {
    const childPath = fileSystem.resolvePath(absolutePath, entry.name);
    const isDirectory = entry.isDirectory;
    const isFile = entry.isFile;

    if (!isDirectory && !isFile) {
      let stat;
      try {
        stat = await fileSystem.stat(childPath);
      } catch {
        continue;
      }

      if (stat.isDirectory) {
        paths.push(...(await listAutomationWorkspaceFilePaths(fileSystem, childPath)));
        continue;
      }

      if (stat.isFile) {
        paths.push(childPath);
      }

      continue;
    }

    if (isDirectory) {
      paths.push(...(await listAutomationWorkspaceFilePaths(fileSystem, childPath)));
      continue;
    }

    paths.push(childPath);
  }

  return paths;
};

const readAutomationWorkspaceTextFile = async (
  fileSystem: IFileSystem,
  absolutePath: string,
  label: string,
) => {
  try {
    return await fileSystem.readFile(absolutePath, "utf-8");
  } catch (error) {
    throw new Error(
      `${label} '${absolutePath}' could not be read from the automation workspace: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const getAutomationLayerForPath = (absolutePath: string): AutomationScriptLayer =>
  absolutePath.startsWith(`${AUTOMATION_SYSTEM_ROOT}/`) ? "system" : "workspace";

const toScriptKey = (path: string) => path.replace(/^scripts\//, "").replace(/\.[^.]+$/, "");

const toScriptName = (path: string) => {
  const key = toScriptKey(path);
  const segments = key
    .split(/[/._-]+/)
    .filter(Boolean)
    .map((segment) => `${segment.slice(0, 1).toUpperCase()}${segment.slice(1)}`);

  return segments.join(" ") || path;
};

const toScriptCatalogEntry = async (
  fileSystem: IFileSystem,
  workspaceScript: AutomationWorkspaceScriptEntry,
): Promise<AutomationScriptCatalogEntry> => {
  const body = await readAutomationWorkspaceTextFile(
    fileSystem,
    workspaceScript.absolutePath,
    "Automation script",
  );
  const key = toScriptKey(workspaceScript.path);
  const layer = getAutomationLayerForPath(workspaceScript.absolutePath);

  return {
    id: `script:${layer}:${key}@1:${workspaceScript.path}`,
    key,
    name: toScriptName(workspaceScript.path),
    engine: workspaceScript.engine,
    path: workspaceScript.path,
    absolutePath: workspaceScript.absolutePath,
    version: 1,
    body,
    scriptLoadError: null,
    enabled: workspaceScript.kind === "script",
  };
};

/**
 * Intentionally minimal filesystem with no upload, resend, or durable hooks.
 * Only used as a last-resort fallback when no `env` or pre-built filesystem is
 * available (e.g. the bash engine runtime path). In production the automations
 * DO always supplies a full filesystem via `getAutomationFileSystem`.
 */
export const createMinimalFileSystem = async (orgId?: string): Promise<IFileSystem> => {
  return createMasterFileSystem({
    orgId: orgId?.trim() || "automation-default-org",
    uploadConfig: null,
  });
};

export const listAutomationWorkspaceScripts = async (
  fileSystem: IFileSystem,
): Promise<AutomationWorkspaceScriptEntry[]> => {
  const absolutePaths = (
    await Promise.all(
      AUTOMATION_ROOTS.map((root) => listAutomationWorkspaceFilePaths(fileSystem, root)),
    )
  ).flat();

  return absolutePaths
    .map((absolutePath) => {
      const path = toAutomationWorkspaceRelativePath(absolutePath);
      return {
        layer: getAutomationLayerForPath(absolutePath),
        path,
        absolutePath,
        engine: inferWorkspaceScriptEngine(path),
        kind: path.endsWith(".workflow.js") ? ("workflow" as const) : ("script" as const),
      };
    })
    .sort(compareWorkspaceScriptEntries);
};

export const readAutomationWorkspaceScript = async (
  fileSystem: IFileSystem,
  scriptPath: string,
): Promise<AutomationScriptCatalogEntry> => {
  const trimmedPath = scriptPath.trim();
  const isAbsoluteAutomationPath = trimmedPath.startsWith("/");
  const normalizedPath = normalizeScriptRelativePath(trimmedPath, trimmedPath || "script");
  const absolutePath = isAbsoluteAutomationPath
    ? trimmedPath
    : toAbsoluteAutomationPath(normalizedPath);
  const layer = getAutomationLayerForPath(absolutePath);
  const body = await readAutomationWorkspaceTextFile(fileSystem, absolutePath, "Automation script");

  return {
    id: `script:${layer}:${toScriptKey(normalizedPath)}@1:${normalizedPath}`,
    key: toScriptKey(normalizedPath),
    name: toScriptName(normalizedPath),
    engine: inferWorkspaceScriptEngine(normalizedPath),
    path: normalizedPath,
    absolutePath,
    version: 1,
    body,
    scriptLoadError: null,
    enabled: !normalizedPath.endsWith(".workflow.js"),
  } satisfies AutomationScriptCatalogEntry;
};

export const resolveAutomationFileSystem = async (
  config: AutomationFileSystemConfig,
  input: AutomationFileSystemResolverInput,
): Promise<IFileSystem> => {
  if (config.getAutomationFileSystem) {
    return await config.getAutomationFileSystem(input);
  }

  if (config.automationFileSystem) {
    return config.automationFileSystem;
  }

  return createMinimalFileSystem(input.orgId);
};

export const loadAutomationCatalog = async (
  fileSystem: IFileSystem,
): Promise<AutomationCatalog> => {
  const workspaceScripts = await listAutomationWorkspaceScripts(fileSystem);
  const scripts = await Promise.all(
    workspaceScripts.map((script) => toScriptCatalogEntry(fileSystem, script)),
  );

  return {
    version: 1,
    bindings: [],
    scripts: scripts.sort(compareScriptEntries),
  };
};

export const loadAutomationCatalogFromConfig = async (
  config: AutomationFileSystemConfig,
  input: AutomationFileSystemResolverInput,
): Promise<AutomationCatalog> => {
  const fileSystem = await resolveAutomationFileSystem(config, input);
  return loadAutomationCatalog(fileSystem);
};
