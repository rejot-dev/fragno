import {
  createMasterFileSystem,
  normalizeRelativePath,
  type DirentEntry,
  type IFileSystem,
} from "@/files";
import { FileSystemError } from "@/files/fs-errors";

import { AUTOMATION_TRIGGER_ORDER_LAST } from "./schema";

export const AUTOMATION_WORKSPACE_ROOT = "/workspace/automations";
export const AUTOMATION_SCRIPTS_ROOT = AUTOMATION_WORKSPACE_ROOT;
export const AUTOMATION_SCRIPT_AGENT_ENV_KEY = "AUTOMATION_SCRIPT_AGENT";

const AUTOMATION_WORKSPACE_ROOT_RELATIVE = AUTOMATION_WORKSPACE_ROOT.slice(1);

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

type AutomationScriptBindingStats = {
  bindingIds: string[];
  bindingCount: number;
  enabledBindingCount: number;
  enabled: boolean;
};

type AutomationBindingMetadata = {
  id: string;
  source: string;
  eventType: string;
  enabled: boolean;
  triggerOrder: number | null;
  scriptId: string;
  scriptKey: string;
  scriptName: string;
  scriptPath: string;
  absoluteScriptPath: string;
  scriptVersion: number;
  scriptEngine: AutomationScriptEngine;
  scriptEnv: Record<string, string>;
};

type AutomationScriptSource = {
  body: string;
  scriptLoadError?: string | null;
};

export type AutomationScriptCatalogEntry = AutomationScriptMetadata &
  AutomationScriptSource &
  AutomationScriptBindingStats;

export type AutomationBindingCatalogEntry = AutomationBindingMetadata & {
  scriptBody: string;
  scriptLoadError?: string | null;
};

export type AutomationWorkflowCatalogEntry = AutomationScriptMetadata &
  AutomationScriptSource & {
    engine: "codemode";
  };

export type AutomationCatalog = {
  version: 1;
  bindings: AutomationBindingCatalogEntry[];
  scripts: AutomationScriptCatalogEntry[];
  workflows: AutomationWorkflowCatalogEntry[];
};

export type AutomationWorkspaceScriptEntry = {
  path: string;
  absolutePath: string;
  engine: AutomationScriptEngine;
  kind: "script" | "workflow";
};

const resolveTriggerOrder = (value: number | null | undefined) =>
  value == null ? AUTOMATION_TRIGGER_ORDER_LAST : value;

const inferWorkspaceScriptEngine = (path: string): AutomationScriptEngine =>
  path.endsWith(".js") ? "codemode" : "bash";

const isAutomationWorkflowPath = (path: string) => path.endsWith(".workflow.js");
const isAutomationScriptPath = (path: string) =>
  !isAutomationWorkflowPath(path) && (path.endsWith(".js") || path.endsWith(".sh"));

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

    if (
      normalizedAbsolutePath !== AUTOMATION_WORKSPACE_ROOT_RELATIVE &&
      !normalizedAbsolutePath.startsWith(`${AUTOMATION_WORKSPACE_ROOT_RELATIVE}/`)
    ) {
      throw new Error(`${label} path '${value}' must stay under ${AUTOMATION_WORKSPACE_ROOT}.`);
    }

    return normalizedAbsolutePath.slice(`${AUTOMATION_WORKSPACE_ROOT_RELATIVE}/`.length);
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

const toAutomationWorkspaceRelativePath = (absolutePath: string) => {
  if (!absolutePath.startsWith(`${AUTOMATION_WORKSPACE_ROOT}/`)) {
    throw new Error(
      `Automation path '${absolutePath}' must stay under ${AUTOMATION_WORKSPACE_ROOT}.`,
    );
  }

  return normalizeRelativePath(absolutePath.slice(`${AUTOMATION_WORKSPACE_ROOT}/`.length));
};

const compareWorkspaceScriptEntries = (
  left: AutomationWorkspaceScriptEntry,
  right: AutomationWorkspaceScriptEntry,
) => left.path.localeCompare(right.path) || left.absolutePath.localeCompare(right.absolutePath);

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
  const absolutePaths = await listAutomationWorkspaceFilePaths(
    fileSystem,
    AUTOMATION_WORKSPACE_ROOT,
  );

  const entries: AutomationWorkspaceScriptEntry[] = [];
  for (const absolutePath of absolutePaths) {
    const path = toAutomationWorkspaceRelativePath(absolutePath);
    if (isAutomationWorkflowPath(path)) {
      entries.push({ path, absolutePath, engine: "codemode", kind: "workflow" });
      continue;
    }
    if (isAutomationScriptPath(path)) {
      entries.push({
        path,
        absolutePath,
        engine: inferWorkspaceScriptEngine(path),
        kind: "script",
      });
    }
  }

  return entries.sort(compareWorkspaceScriptEntries);
};

export const readAutomationWorkspaceScript = async (
  fileSystem: IFileSystem,
  scriptPath: string,
): Promise<AutomationScriptCatalogEntry> => {
  const normalizedPath = normalizeScriptRelativePath(scriptPath, scriptPath.trim() || "script");
  const absolutePath = toAbsoluteAutomationPath(normalizedPath);
  const body = await readAutomationWorkspaceTextFile(fileSystem, absolutePath, "Automation script");

  return {
    id: normalizedPath,
    key: normalizedPath.replace(/^scripts\//, "").replace(/\.[^.]+$/, ""),
    name: normalizedPath,
    engine: inferWorkspaceScriptEngine(normalizedPath),
    path: normalizedPath,
    absolutePath,
    version: 1,
    body,
    scriptLoadError: null,
    bindingIds: [],
    bindingCount: 0,
    enabledBindingCount: 0,
    enabled: false,
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
  const entries = await listAutomationWorkspaceScripts(fileSystem);
  const scripts: AutomationScriptCatalogEntry[] = [];
  const workflows: AutomationWorkflowCatalogEntry[] = [];

  for (const entry of entries) {
    let source: AutomationScriptSource;
    try {
      source = {
        body: await readAutomationWorkspaceTextFile(
          fileSystem,
          entry.absolutePath,
          "Automation script",
        ),
        scriptLoadError: null,
      };
    } catch (error) {
      source = {
        body: "",
        scriptLoadError: error instanceof Error ? error.message : "Failed to read script file.",
      };
    }

    const base: AutomationScriptMetadata & AutomationScriptSource = {
      id: `script:${entry.absolutePath}`,
      key: entry.path.replace(/\.(workflow\.)?js$|\.sh$/u, ""),
      name: entry.path.split("/").at(-1) ?? entry.path,
      engine: entry.engine,
      path: entry.path,
      absolutePath: entry.absolutePath,
      version: 1,
      ...source,
    };

    if (entry.kind === "workflow") {
      workflows.push({ ...base, engine: "codemode" });
    } else {
      scripts.push({
        ...base,
        bindingIds: [],
        bindingCount: 0,
        enabledBindingCount: 1,
        enabled: true,
      });
    }
  }

  const sortedScripts = scripts.sort((left, right) => left.path.localeCompare(right.path));
  const bindings: AutomationBindingCatalogEntry[] = sortedScripts.map((script) => ({
    id: script.id,
    source: "*",
    eventType: "*",
    enabled: true,
    triggerOrder: null,
    scriptId: script.id,
    scriptKey: script.key,
    scriptName: script.name,
    scriptPath: script.path,
    absoluteScriptPath: script.absolutePath,
    scriptVersion: script.version,
    scriptEngine: script.engine,
    scriptEnv: {},
    scriptBody: script.body,
    scriptLoadError: script.scriptLoadError,
  }));

  return {
    version: 1,
    bindings,
    scripts: sortedScripts,
    workflows: workflows.sort((left, right) => left.path.localeCompare(right.path)),
  } satisfies AutomationCatalog;
};

export const loadAutomationCatalogFromConfig = async (
  config: AutomationFileSystemConfig,
  input: AutomationFileSystemResolverInput,
): Promise<AutomationCatalog> => {
  const fileSystem = await resolveAutomationFileSystem(config, input);
  return loadAutomationCatalog(fileSystem);
};

export const getAutomationBindingsForEvent = <
  TBinding extends {
    id: string;
    enabled: boolean;
    source: string;
    eventType: string;
    triggerOrder: number | null;
  },
>(
  catalog: { bindings: TBinding[] },
  event: { source: string; eventType: string },
): TBinding[] => {
  return catalog.bindings
    .filter(
      (binding) =>
        binding.enabled &&
        (binding.source === "*" || binding.source === event.source) &&
        (binding.eventType === "*" || binding.eventType === event.eventType),
    )
    .slice()
    .sort((left, right) => {
      const order =
        resolveTriggerOrder(left.triggerOrder) - resolveTriggerOrder(right.triggerOrder);
      if (order !== 0) {
        return order;
      }

      return left.id.localeCompare(right.id);
    });
};
