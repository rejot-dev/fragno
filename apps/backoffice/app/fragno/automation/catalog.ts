import { z } from "zod";

import {
  createMasterFileSystem,
  normalizeRelativePath,
  type DirentEntry,
  type IFileSystem,
} from "@/files";
import { FileSystemError } from "@/files/fs-errors";

import { AUTOMATION_TRIGGER_ORDER_LAST } from "./schema";

export const AUTOMATION_WORKSPACE_ROOT = "/workspace/automations";
export const AUTOMATION_BINDINGS_MANIFEST_PATH = `${AUTOMATION_WORKSPACE_ROOT}/bindings.json`;
export const AUTOMATION_SCRIPTS_ROOT = `${AUTOMATION_WORKSPACE_ROOT}/scripts`;
export const AUTOMATION_SCRIPT_AGENT_ENV_KEY = "AUTOMATION_SCRIPT_AGENT";

const AUTOMATION_WORKSPACE_ROOT_RELATIVE = AUTOMATION_WORKSPACE_ROOT.slice(1);
const AUTOMATION_SCRIPTS_ROOT_RELATIVE = AUTOMATION_SCRIPTS_ROOT.slice(1);

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

const manifestScriptSchema = z.object({
  key: z.string().trim().min(1),
  name: z.string().trim().min(1),
  engine: z.literal("bash"),
  path: z.string().trim().min(1),
  version: z.number().int().min(1).default(1),
  agent: z.string().trim().min(1).nullable().optional().default(null),
  env: z.record(z.string(), z.string()).default({}),
});

const manifestBindingSchema = z.object({
  id: z.string().trim().min(1),
  source: z.string().trim().min(1),
  eventType: z.string().trim().min(1),
  enabled: z.boolean().optional().default(true),
  triggerOrder: z.number().int().nullable().optional(),
  script: manifestScriptSchema,
});

const automationManifestSchema = z.object({
  version: z.literal(1),
  bindings: z.array(manifestBindingSchema),
});

export type AutomationManifest = z.infer<typeof automationManifestSchema>;
export type AutomationManifestBinding = AutomationManifest["bindings"][number];

export type AutomationManifestScriptEntry = {
  id: string;
  key: string;
  name: string;
  engine: "bash";
  path: string;
  absolutePath: string;
  version: number;
  bindingIds: string[];
  bindingCount: number;
  enabledBindingCount: number;
  enabled: boolean;
};

export type AutomationManifestBindingEntry = {
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
  scriptEngine: "bash";
  scriptEnv: Record<string, string>;
};

export type AutomationManifestSummary = {
  version: 1;
  manifestPath: string;
  bindings: AutomationManifestBindingEntry[];
  scripts: AutomationManifestScriptEntry[];
};

export type AutomationScriptCatalogEntry = {
  id: string;
  key: string;
  name: string;
  engine: "bash";
  path: string;
  absolutePath: string;
  version: number;
  body: string;
  scriptLoadError?: string | null;
  bindingIds: string[];
  bindingCount: number;
  enabledBindingCount: number;
  enabled: boolean;
};

export type AutomationBindingCatalogEntry = {
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
  scriptEngine: "bash";
  scriptEnv: Record<string, string>;
  scriptBody: string;
  scriptLoadError?: string | null;
};

export type AutomationCatalog = {
  version: 1;
  manifestPath: string;
  bindings: AutomationBindingCatalogEntry[];
  scripts: AutomationScriptCatalogEntry[];
};

export type AutomationWorkspaceScriptEntry = {
  path: string;
  absolutePath: string;
  engine: "bash";
};

const resolveTriggerOrder = (value: number | null | undefined) =>
  value == null ? AUTOMATION_TRIGGER_ORDER_LAST : value;

const normalizeScriptRelativePath = (value: string, bindingId: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Automation binding '${bindingId}' is missing script.path.`);
  }

  if (trimmed.startsWith("/")) {
    let normalizedAbsolutePath: string;
    try {
      normalizedAbsolutePath = normalizeRelativePath(trimmed.slice(1));
    } catch (error) {
      throw new Error(
        `Automation binding '${bindingId}' has invalid script path '${value}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!normalizedAbsolutePath.startsWith(`${AUTOMATION_SCRIPTS_ROOT_RELATIVE}/`)) {
      throw new Error(
        `Automation binding '${bindingId}' has invalid script path '${value}'. Absolute paths must stay under ${AUTOMATION_SCRIPTS_ROOT}.`,
      );
    }

    return normalizedAbsolutePath.slice(`${AUTOMATION_WORKSPACE_ROOT_RELATIVE}/`.length);
  }

  let normalized: string;
  try {
    normalized = normalizeRelativePath(trimmed);
  } catch (error) {
    throw new Error(
      `Automation binding '${bindingId}' has invalid script path '${value}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!normalized.startsWith("scripts/")) {
    throw new Error(
      `Automation binding '${bindingId}' has invalid script path '${value}'. Relative paths must stay under scripts/ or use an absolute path under ${AUTOMATION_SCRIPTS_ROOT}.`,
    );
  }

  return normalized;
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

const createScriptId = (binding: AutomationManifestBinding, scriptPath: string) =>
  `script:${binding.script.key}@${binding.script.version}:${scriptPath}`;

const resolveBindingScriptEnv = (binding: AutomationManifestBinding): Record<string, string> => {
  const scriptEnv = { ...binding.script.env };
  const legacyAgent = binding.script.agent;
  const agentEnv = scriptEnv[AUTOMATION_SCRIPT_AGENT_ENV_KEY];

  if (legacyAgent && typeof agentEnv === "string" && agentEnv.trim() && agentEnv !== legacyAgent) {
    throw new Error(
      `Automation binding '${binding.id}' defines both script.agent and script.env.${AUTOMATION_SCRIPT_AGENT_ENV_KEY} with different values.`,
    );
  }

  if (legacyAgent) {
    scriptEnv[AUTOMATION_SCRIPT_AGENT_ENV_KEY] = legacyAgent;
  }

  return scriptEnv;
};

const compareScriptEntries = (
  left: AutomationScriptCatalogEntry,
  right: AutomationScriptCatalogEntry,
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

const compareBindingEntries = <
  TBinding extends { source: string; eventType: string; triggerOrder: number | null; id: string },
>(
  left: TBinding,
  right: TBinding,
) => {
  const sourceOrder = left.source.localeCompare(right.source);
  if (sourceOrder !== 0) {
    return sourceOrder;
  }

  const eventTypeOrder = left.eventType.localeCompare(right.eventType);
  if (eventTypeOrder !== 0) {
    return eventTypeOrder;
  }

  const triggerOrder =
    resolveTriggerOrder(left.triggerOrder) - resolveTriggerOrder(right.triggerOrder);
  if (triggerOrder !== 0) {
    return triggerOrder;
  }

  return left.id.localeCompare(right.id);
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

const assertCompatibleScriptEntry = (
  existing: AutomationScriptCatalogEntry,
  next: Omit<
    AutomationScriptCatalogEntry,
    "bindingIds" | "bindingCount" | "enabledBindingCount" | "enabled"
  >,
  bindingId: string,
) => {
  if (
    existing.key !== next.key ||
    existing.name !== next.name ||
    existing.engine !== next.engine ||
    existing.path !== next.path ||
    existing.absolutePath !== next.absolutePath ||
    existing.version !== next.version ||
    existing.body !== next.body
  ) {
    throw new Error(
      `Automation binding '${bindingId}' reuses script identity '${existing.id}' with conflicting script metadata.`,
    );
  }
};

const parseAutomationManifest = (content: string): AutomationManifest => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Automation manifest '${AUTOMATION_BINDINGS_MANIFEST_PATH}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = automationManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Automation manifest '${AUTOMATION_BINDINGS_MANIFEST_PATH}' is invalid: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  return result.data;
};

const readRequiredFile = async (fileSystem: IFileSystem, absolutePath: string, label: string) => {
  try {
    return await fileSystem.readFile(absolutePath, "utf-8");
  } catch (error) {
    throw new Error(
      `${label} '${absolutePath}' was not found in the automation workspace: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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

const buildAutomationManifestSummary = (
  manifest: AutomationManifest,
): AutomationManifestSummary => {
  const bindingIds = new Set<string>();
  const scriptsById = new Map<string, AutomationManifestScriptEntry>();
  const bindings = [] as AutomationManifestBindingEntry[];

  for (const binding of manifest.bindings) {
    if (bindingIds.has(binding.id)) {
      throw new Error(`Automation manifest contains duplicate binding id '${binding.id}'.`);
    }
    bindingIds.add(binding.id);

    const scriptPath = normalizeScriptRelativePath(binding.script.path, binding.id);
    const absoluteScriptPath = toAbsoluteAutomationPath(scriptPath);
    const scriptId = createScriptId(binding, scriptPath);
    const scriptEnv = resolveBindingScriptEnv(binding);
    const existingScript = scriptsById.get(scriptId);

    if (existingScript) {
      if (
        existingScript.key !== binding.script.key ||
        existingScript.name !== binding.script.name ||
        existingScript.engine !== binding.script.engine ||
        existingScript.path !== scriptPath ||
        existingScript.absolutePath !== absoluteScriptPath ||
        existingScript.version !== binding.script.version
      ) {
        throw new Error(
          `Automation binding '${binding.id}' reuses script identity '${existingScript.id}' with conflicting script metadata.`,
        );
      }

      existingScript.bindingIds.push(binding.id);
      existingScript.bindingCount += 1;
      if (binding.enabled !== false) {
        existingScript.enabledBindingCount += 1;
        existingScript.enabled = true;
      }
    } else {
      scriptsById.set(scriptId, {
        id: scriptId,
        key: binding.script.key,
        name: binding.script.name,
        engine: binding.script.engine,
        path: scriptPath,
        absolutePath: absoluteScriptPath,
        version: binding.script.version,
        bindingIds: [binding.id],
        bindingCount: 1,
        enabledBindingCount: binding.enabled !== false ? 1 : 0,
        enabled: binding.enabled !== false,
      });
    }

    bindings.push({
      id: binding.id,
      source: binding.source,
      eventType: binding.eventType,
      enabled: binding.enabled !== false,
      triggerOrder: binding.triggerOrder ?? null,
      scriptId,
      scriptKey: binding.script.key,
      scriptName: binding.script.name,
      scriptPath,
      absoluteScriptPath,
      scriptVersion: binding.script.version,
      scriptEngine: binding.script.engine,
      scriptEnv,
    });
  }

  const scripts = Array.from(scriptsById.values())
    .map((script) => ({
      ...script,
      bindingIds: script.bindingIds.slice().sort(),
    }))
    .sort((left, right) => {
      const nameOrder = left.name.localeCompare(right.name);
      if (nameOrder !== 0) {
        return nameOrder;
      }

      const keyOrder = left.key.localeCompare(right.key);
      if (keyOrder !== 0) {
        return keyOrder;
      }

      return left.path.localeCompare(right.path);
    });

  return {
    version: manifest.version,
    manifestPath: AUTOMATION_BINDINGS_MANIFEST_PATH,
    bindings: bindings.sort(compareBindingEntries),
    scripts,
  } satisfies AutomationManifestSummary;
};

export const loadAutomationManifest = async (
  fileSystem: IFileSystem,
): Promise<AutomationManifest> => {
  const manifestContent = await readRequiredFile(
    fileSystem,
    AUTOMATION_BINDINGS_MANIFEST_PATH,
    "Automation manifest",
  );
  return parseAutomationManifest(manifestContent);
};

export const loadAutomationManifestSummary = async (
  fileSystem: IFileSystem,
): Promise<AutomationManifestSummary> => {
  const manifest = await loadAutomationManifest(fileSystem);
  return buildAutomationManifestSummary(manifest);
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
  const absolutePaths = await listAutomationWorkspaceFilePaths(fileSystem, AUTOMATION_SCRIPTS_ROOT);

  return absolutePaths
    .map((absolutePath) => ({
      path: toAutomationWorkspaceRelativePath(absolutePath),
      absolutePath,
      engine: "bash" as const,
    }))
    .sort(compareWorkspaceScriptEntries);
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
    engine: "bash",
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
  const manifestContent = await readRequiredFile(
    fileSystem,
    AUTOMATION_BINDINGS_MANIFEST_PATH,
    "Automation manifest",
  );
  const manifest = parseAutomationManifest(manifestContent);

  const bindingIds = new Set<string>();
  const scriptsById = new Map<
    string,
    Omit<
      AutomationScriptCatalogEntry,
      "bindingCount" | "bindingIds" | "enabledBindingCount" | "enabled"
    >
  >();
  const scriptBindingIds = new Map<string, string[]>();
  const scriptEnabledBindingCounts = new Map<string, number>();

  const bindings = [] as AutomationBindingCatalogEntry[];

  for (const binding of manifest.bindings) {
    if (bindingIds.has(binding.id)) {
      throw new Error(`Automation manifest contains duplicate binding id '${binding.id}'.`);
    }
    bindingIds.add(binding.id);

    const scriptPath = normalizeScriptRelativePath(binding.script.path, binding.id);
    const absoluteScriptPath = toAbsoluteAutomationPath(scriptPath);
    const scriptId = createScriptId(binding, scriptPath);
    const scriptEnv = resolveBindingScriptEnv(binding);

    const existingScript = scriptsById.get(scriptId);

    let scriptBody: string;
    let scriptLoadError: string | null = null;

    if (existingScript) {
      scriptBody = existingScript.body;
      scriptLoadError = existingScript.scriptLoadError ?? null;

      assertCompatibleScriptEntry(
        {
          ...existingScript,
          bindingIds: [],
          bindingCount: 0,
          enabledBindingCount: 0,
          enabled: false,
        },
        {
          id: scriptId,
          key: binding.script.key,
          name: binding.script.name,
          engine: binding.script.engine,
          path: scriptPath,
          absolutePath: absoluteScriptPath,
          version: binding.script.version,
          body: scriptBody,
          scriptLoadError,
        } satisfies Omit<
          AutomationScriptCatalogEntry,
          "bindingCount" | "bindingIds" | "enabledBindingCount" | "enabled"
        >,
        binding.id,
      );
    } else {
      try {
        scriptBody = await readRequiredFile(
          fileSystem,
          absoluteScriptPath,
          `Automation script for binding '${binding.id}'`,
        );
      } catch (error) {
        scriptBody = "";
        scriptLoadError = error instanceof Error ? error.message : "Failed to read script file.";
      }

      scriptsById.set(scriptId, {
        id: scriptId,
        key: binding.script.key,
        name: binding.script.name,
        engine: binding.script.engine,
        path: scriptPath,
        absolutePath: absoluteScriptPath,
        version: binding.script.version,
        body: scriptBody,
        scriptLoadError,
      });
    }

    const bindingsForScript = scriptBindingIds.get(scriptId) ?? [];
    bindingsForScript.push(binding.id);
    scriptBindingIds.set(scriptId, bindingsForScript);
    scriptEnabledBindingCounts.set(
      scriptId,
      (scriptEnabledBindingCounts.get(scriptId) ?? 0) + (binding.enabled !== false ? 1 : 0),
    );

    bindings.push({
      id: binding.id,
      source: binding.source,
      eventType: binding.eventType,
      enabled: binding.enabled !== false,
      triggerOrder: binding.triggerOrder ?? null,
      scriptId,
      scriptKey: binding.script.key,
      scriptName: binding.script.name,
      scriptPath: scriptPath,
      absoluteScriptPath,
      scriptVersion: binding.script.version,
      scriptEngine: binding.script.engine,
      scriptEnv,
      scriptBody,
      scriptLoadError,
    });
  }

  const scripts = Array.from(scriptsById.values())
    .map((script) => {
      const bindingIdsForScript = (scriptBindingIds.get(script.id) ?? []).slice().sort();
      const enabledBindingCount = scriptEnabledBindingCounts.get(script.id) ?? 0;
      return {
        ...script,
        bindingIds: bindingIdsForScript,
        bindingCount: bindingIdsForScript.length,
        enabledBindingCount,
        enabled: enabledBindingCount > 0,
      } satisfies AutomationScriptCatalogEntry;
    })
    .sort(compareScriptEntries);

  return {
    version: manifest.version,
    manifestPath: AUTOMATION_BINDINGS_MANIFEST_PATH,
    bindings: bindings.sort(compareBindingEntries),
    scripts,
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
        binding.enabled && binding.source === event.source && binding.eventType === event.eventType,
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
