import { createRouteCaller } from "@fragno-dev/core/api";
import type { RouterContextProvider } from "react-router";

import { CloudflareContext } from "@/cloudflare/cloudflare-context";
import { getAutomationsDurableObject } from "@/cloudflare/cloudflare-utils";
import { createOrgFileSystem } from "@/files";
import {
  AUTOMATION_WORKSPACE_ROOT,
  listAutomationScenarios,
  listAutomationWorkspaceScripts,
  loadAutomationManifestSummary,
  readAutomationWorkspaceScript,
  type AutomationManifestSummary,
  type AutomationScenarioCatalogEntry,
  type AutomationSimulationResult,
  type AutomationWorkspaceScriptEntry,
  type createAutomationFragment,
} from "@/fragno/automation";

type AutomationFragment = ReturnType<typeof createAutomationFragment>;

type AutomationIdLike =
  | string
  | {
      externalId?: string | null;
      id?: string | null;
    }
  | null
  | undefined;

export type AutomationScriptRecord = {
  id: string;
  key: string;
  name: string;
  engine: "bash";
  path: string;
  absolutePath: string;
  version: number | null;
  scriptLoadError?: string | null;
  bindingIds: string[];
  bindingCount: number;
  enabledBindingCount: number;
  enabled: boolean;
};

export type AutomationTriggerBindingRecord = AutomationManifestSummary["bindings"][number];
export type AutomationScenarioRecord = AutomationScenarioCatalogEntry;

export type AutomationIdentityBindingRecord = {
  id?: AutomationIdLike;
  source?: string | null;
  key?: string | null;
  value?: string | null;
  description?: string | null;
  status?: string | null;
  linkedAt?: string | Date | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
};

export type AutomationScriptSourceRecord = {
  script: string | null;
  scriptError: string | null;
};

const AUTOMATION_SCRIPT_ID_PREFIX = "workspace-script:";
const isSuccessStatus = (status: number) => status >= 200 && status < 300;
const formatErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

const createAutomationsRouteCaller = (
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
) => {
  const automationsDo = getAutomationsDurableObject(context, orgId);
  return createRouteCaller<AutomationFragment>({
    baseUrl: request.url,
    mountRoute: "/api/automations/bindings",
    baseHeaders: request.headers,
    fetch: async (outboundRequest) => {
      const url = new URL(outboundRequest.url);
      url.searchParams.set("orgId", orgId);
      return automationsDo.fetch(new Request(url.toString(), outboundRequest));
    },
  });
};

const toRecordArray = <T extends Record<string, unknown>>(value: unknown): T[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is T => Boolean(item) && typeof item === "object");
};

const createBackofficeAutomationFileSystem = async ({
  context,
  orgId,
}: {
  context: Readonly<RouterContextProvider>;
  orgId: string;
}) => {
  const { env } = context.get(CloudflareContext);
  return createOrgFileSystem({ orgId, env });
};

const normalizeAutomationScriptPath = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const workspacePrefix = `${AUTOMATION_WORKSPACE_ROOT}/`;
  if (trimmed.startsWith(workspacePrefix)) {
    return trimmed.slice(workspacePrefix.length);
  }

  return trimmed.replace(/^\/+/, "");
};

const buildAutomationScriptKey = (path: string) => {
  const normalizedPath = normalizeAutomationScriptPath(path);
  const withoutScriptsRoot = normalizedPath.replace(/^scripts\//, "");
  const withoutExtension = withoutScriptsRoot.replace(/\.[^.]+$/, "");
  return withoutExtension || normalizedPath;
};

const buildAutomationScriptName = (path: string) => {
  const key = buildAutomationScriptKey(path);
  const segments = key
    .split(/[/._-]+/)
    .filter(Boolean)
    .map((segment) => `${segment.slice(0, 1).toUpperCase()}${segment.slice(1)}`);

  return segments.join(" ") || path;
};

const buildMissingScriptError = ({
  bindingId,
  absolutePath,
}: {
  bindingId: string;
  absolutePath: string;
}) =>
  `Automation script for binding '${bindingId}' '${absolutePath}' was not found in the automation workspace: File not found.`;

const buildWorkspaceScriptRecord = (
  script: AutomationWorkspaceScriptEntry,
): AutomationScriptRecord => ({
  id: toAutomationScriptId(script.path),
  key: buildAutomationScriptKey(script.path),
  name: buildAutomationScriptName(script.path),
  engine: script.engine,
  path: script.path,
  absolutePath: script.absolutePath,
  version: null,
  scriptLoadError: null,
  bindingIds: [],
  bindingCount: 0,
  enabledBindingCount: 0,
  enabled: false,
});

const mergeAutomationScripts = ({
  workspaceScripts,
  manifest,
}: {
  workspaceScripts: AutomationWorkspaceScriptEntry[];
  manifest: AutomationManifestSummary | null;
}): AutomationScriptRecord[] => {
  const scriptsByPath = new Map<string, AutomationScriptRecord>();
  const workspaceScriptPaths = new Set<string>();

  for (const workspaceScript of workspaceScripts) {
    const normalizedPath = normalizeAutomationScriptPath(workspaceScript.path);
    workspaceScriptPaths.add(normalizedPath);
    scriptsByPath.set(normalizedPath, buildWorkspaceScriptRecord(workspaceScript));
  }

  for (const manifestScript of manifest?.scripts ?? []) {
    const normalizedPath = normalizeAutomationScriptPath(manifestScript.path);
    const existing = scriptsByPath.get(normalizedPath) ?? null;
    const missingBindingId = manifestScript.bindingIds[0] ?? manifestScript.id;

    scriptsByPath.set(normalizedPath, {
      id: toAutomationScriptId(manifestScript.path),
      key: manifestScript.key,
      name: manifestScript.name,
      engine: manifestScript.engine,
      path: normalizedPath,
      absolutePath: manifestScript.absolutePath,
      version: manifestScript.version,
      scriptLoadError: workspaceScriptPaths.has(normalizedPath)
        ? (existing?.scriptLoadError ?? null)
        : buildMissingScriptError({
            bindingId: missingBindingId,
            absolutePath: manifestScript.absolutePath,
          }),
      bindingIds: manifestScript.bindingIds,
      bindingCount: manifestScript.bindingCount,
      enabledBindingCount: manifestScript.enabledBindingCount,
      enabled: manifestScript.enabled,
    });
  }

  return Array.from(scriptsByPath.values()).sort(
    (left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path),
  );
};

export const toAutomationScriptId = (path: string): string =>
  `${AUTOMATION_SCRIPT_ID_PREFIX}${normalizeAutomationScriptPath(path)}`;

export const fromAutomationScriptId = (value: string): string =>
  value.startsWith(AUTOMATION_SCRIPT_ID_PREFIX)
    ? value.slice(AUTOMATION_SCRIPT_ID_PREFIX.length)
    : normalizeAutomationScriptPath(value);

export const toExternalId = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  if ("externalId" in value && typeof value.externalId === "string") {
    return value.externalId;
  }

  if ("id" in value && typeof value.id === "string") {
    return value.id;
  }

  return "";
};

export async function loadAutomationWorkspaceData({
  context,
  orgId,
}: {
  context: Readonly<RouterContextProvider>;
  orgId: string;
}): Promise<{
  scripts: AutomationScriptRecord[];
  scriptsError: string | null;
  bindings: AutomationTriggerBindingRecord[];
  bindingsError: string | null;
}> {
  const fileSystem = await createBackofficeAutomationFileSystem({ context, orgId });

  let workspaceScripts: AutomationWorkspaceScriptEntry[] = [];
  let workspaceScriptsError: string | null = null;
  try {
    workspaceScripts = await listAutomationWorkspaceScripts(fileSystem);
  } catch (error) {
    workspaceScriptsError = formatErrorMessage(error, "Failed to list automation scripts.");
  }

  let manifest: AutomationManifestSummary | null = null;
  let manifestError: string | null = null;
  try {
    manifest = await loadAutomationManifestSummary(fileSystem);
  } catch (error) {
    manifestError = formatErrorMessage(error, "Failed to load automation bindings.");
  }

  return {
    scripts: mergeAutomationScripts({ workspaceScripts, manifest }),
    scriptsError: workspaceScriptsError ?? manifestError,
    bindings: manifest?.bindings ?? [],
    bindingsError: manifestError,
  };
}

export async function loadAutomationScriptSource({
  context,
  orgId,
  scriptId,
}: {
  context: Readonly<RouterContextProvider>;
  orgId: string;
  scriptId: string;
}): Promise<AutomationScriptSourceRecord> {
  const fileSystem = await createBackofficeAutomationFileSystem({ context, orgId });

  try {
    const script = await readAutomationWorkspaceScript(
      fileSystem,
      fromAutomationScriptId(scriptId),
    );
    return {
      script: script.body,
      scriptError: null,
    };
  } catch (error) {
    return {
      script: null,
      scriptError: formatErrorMessage(error, "Failed to load automation script source."),
    };
  }
}

export async function loadAutomationScenariosForScript({
  context,
  orgId,
  scriptId,
}: {
  context: Readonly<RouterContextProvider>;
  orgId: string;
  scriptId: string;
}): Promise<{
  scenarios: AutomationScenarioRecord[];
  scenariosError: string | null;
}> {
  const fileSystem = await createBackofficeAutomationFileSystem({ context, orgId });

  let manifest: AutomationManifestSummary | null = null;
  let manifestError: string | null = null;
  try {
    manifest = await loadAutomationManifestSummary(fileSystem);
  } catch (error) {
    manifestError = formatErrorMessage(error, "Failed to load automation manifest.");
  }

  try {
    const selectedScriptId = fromAutomationScriptId(scriptId);
    const scenarios = await listAutomationScenarios(fileSystem, {
      catalog: manifest,
      allowCatalogErrors: true,
    });

    return {
      scenarios: scenarios.filter((scenario) =>
        scenario.relatedScriptPaths.includes(selectedScriptId),
      ),
      scenariosError: manifestError,
    };
  } catch (error) {
    return {
      scenarios: [],
      scenariosError: formatErrorMessage(error, "Failed to load automation scenarios."),
    };
  }
}

export async function fetchAutomationIdentityBindings(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
): Promise<{
  identityBindings: AutomationIdentityBindingRecord[];
  identityBindingsError: string | null;
}> {
  try {
    const callRoute = createAutomationsRouteCaller(request, context, orgId);
    const response = await callRoute("GET", "/identity-bindings");

    if (response.type === "json" && isSuccessStatus(response.status)) {
      return {
        identityBindings: toRecordArray<AutomationIdentityBindingRecord>(response.data),
        identityBindingsError: null,
      };
    }

    if (response.type === "error") {
      return {
        identityBindings: [],
        identityBindingsError: response.error.message,
      };
    }

    return {
      identityBindings: [],
      identityBindingsError: `Failed to fetch identity bindings (${response.status}).`,
    };
  } catch (error) {
    return {
      identityBindings: [],
      identityBindingsError: formatErrorMessage(error, "Failed to load identity bindings."),
    };
  }
}

export async function runAutomationScenario(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  path: string,
): Promise<{
  ok: boolean;
  result: AutomationSimulationResult | null;
  error: string | null;
}> {
  try {
    const callRoute = createAutomationsRouteCaller(request, context, orgId);
    const response = await callRoute("POST", "/scenarios/run", {
      body: { path },
    });

    if (response.type === "json" && isSuccessStatus(response.status)) {
      return {
        ok: true,
        result: response.data as AutomationSimulationResult,
        error: null,
      };
    }

    if (response.type === "error") {
      return {
        ok: false,
        result: null,
        error: response.error.message,
      };
    }

    return {
      ok: false,
      result: null,
      error: `Failed to run automation scenario (${response.status}).`,
    };
  } catch (error) {
    return {
      ok: false,
      result: null,
      error: formatErrorMessage(error, "Failed to run automation scenario."),
    };
  }
}

export async function revokeAutomationIdentityBinding(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  bindingId: string,
): Promise<{
  ok: boolean;
  error: string | null;
}> {
  try {
    const callRoute = createAutomationsRouteCaller(request, context, orgId);
    const response = await callRoute("POST", "/identity-bindings/:bindingId/revoke", {
      pathParams: { bindingId },
    });

    if (response.type === "json" && isSuccessStatus(response.status)) {
      return { ok: Boolean(response.data?.ok), error: null };
    }

    if (response.type === "error") {
      return { ok: false, error: response.error.message };
    }

    return {
      ok: false,
      error: `Failed to revoke identity binding (${response.status}).`,
    };
  } catch (error) {
    return {
      ok: false,
      error: formatErrorMessage(error, "Failed to revoke identity binding."),
    };
  }
}
