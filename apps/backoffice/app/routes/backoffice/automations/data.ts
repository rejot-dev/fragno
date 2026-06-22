import { createRouteCaller } from "@fragno-dev/core/api";
import type { RouterContextProvider } from "react-router";

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { createBackofficeFileSystem } from "@/files";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import {
  AUTOMATION_SYSTEM_ROOT,
  AUTOMATION_WORKSPACE_ROOT,
  listAutomationWorkspaceScripts,
  readAutomationWorkspaceScript,
  type AutomationScriptLayer,
  type AutomationWorkspaceScriptEntry,
  type createAutomationFragment,
} from "@/fragno/automation";
import type { AutomationScriptEngine } from "@/fragno/automation/catalog";
import type { AutomationEventActor } from "@/fragno/automation/contracts";
import { getAutomationsDurableObject } from "@/worker-runtime/durable-objects";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import {
  booleanActionResultFromCaughtError,
  booleanActionResultFromRouteResponse,
} from "../action-result";

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
  engine: AutomationScriptEngine;
  layer: AutomationScriptLayer;
  readOnly: boolean;
  path: string;
  absolutePath: string;
  version: number | null;
  scriptLoadError?: string | null;
  enabled: boolean;
};

export type AutomationStoreEntryRecord = {
  id?: AutomationIdLike;
  key?: string | null;
  value?: string | null;
  description?: string | null;
  category?: string[] | null;
  actor: AutomationEventActor;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
};

export type AutomationProjectRecord = {
  id?: AutomationIdLike;
  slug?: string | null;
  name?: string | null;
  description?: string | null;
  archivedAt?: string | Date | null;
  createdByUserId?: string | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
};

export type AutomationScriptSourceRecord = {
  script: string | null;
  scriptError: string | null;
};

const AUTOMATION_SCRIPT_ID_PREFIX = "automation-script:";
const formatErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

const isSuccessStatus = (status: number) => status >= 200 && status < 300;

const createAutomationsRouteCaller = (
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
) => {
  const automationsDo = getAutomationsDurableObject(context, orgId);
  return createRouteCaller<AutomationFragment>({
    baseUrl: request.url,
    mountRoute: "/api/automations",
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
  request,
  context,
  orgId,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  orgId: string;
}) => {
  const { runtime } = context.get(BackofficeWorkerContext);
  const kernel = new BackofficeKernel({ objects: runtime.objects });
  const execution = await requireBackofficeContext(request, context, { kind: "org", orgId });
  return createBackofficeFileSystem({ objects: runtime.objects, kernel, execution });
};

const normalizeAutomationScriptPath = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  for (const root of [AUTOMATION_SYSTEM_ROOT, AUTOMATION_WORKSPACE_ROOT]) {
    const prefix = `${root}/`;
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
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

const buildLayeredAutomationScriptName = (script: AutomationWorkspaceScriptEntry) => {
  if (script.path === "router.cm.js") {
    return script.layer === "system" ? "System Router" : "Workspace Router";
  }

  return buildAutomationScriptName(script.path);
};

const buildWorkspaceScriptRecord = (
  script: AutomationWorkspaceScriptEntry,
): AutomationScriptRecord => ({
  id: toAutomationScriptId(script),
  layer: script.layer,
  readOnly: script.layer === "system",
  key: buildAutomationScriptKey(script.path),
  name: buildLayeredAutomationScriptName(script),
  engine: script.engine,
  path: script.path,
  absolutePath: script.absolutePath,
  version: null,
  scriptLoadError: null,
  enabled: script.kind === "script",
});

const toAutomationScriptId = (
  script: Pick<AutomationWorkspaceScriptEntry, "layer" | "path">,
): string =>
  `${AUTOMATION_SCRIPT_ID_PREFIX}${script.layer}:${normalizeAutomationScriptPath(script.path)}`;

const fromAutomationScriptId = (value: string): string => {
  const normalized = value.startsWith(AUTOMATION_SCRIPT_ID_PREFIX)
    ? value.slice(AUTOMATION_SCRIPT_ID_PREFIX.length)
    : value;
  const [layer, ...pathParts] = normalized.split(":");
  const path = normalizeAutomationScriptPath(
    pathParts.length > 0 ? pathParts.join(":") : normalized,
  );

  if (layer === "system") {
    return `${AUTOMATION_SYSTEM_ROOT}/${path}`;
  }
  if (layer === "workspace") {
    return `${AUTOMATION_WORKSPACE_ROOT}/${path}`;
  }

  return path;
};

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

  const primitive = typeof value.valueOf === "function" ? value.valueOf() : null;
  if (typeof primitive === "string" && primitive !== "[object Object]") {
    return primitive;
  }

  return "";
};

export async function loadAutomationWorkspaceData({
  request,
  context,
  orgId,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  orgId: string;
}): Promise<{
  scripts: AutomationScriptRecord[];
  scriptsError: string | null;
}> {
  const fileSystem = await createBackofficeAutomationFileSystem({ request, context, orgId });

  let workspaceScripts: AutomationWorkspaceScriptEntry[] = [];
  let workspaceScriptsError: string | null = null;
  try {
    workspaceScripts = await listAutomationWorkspaceScripts(fileSystem);
  } catch (error) {
    workspaceScriptsError = formatErrorMessage(error, "Failed to list automation scripts.");
  }

  return {
    scripts: workspaceScripts
      .map(buildWorkspaceScriptRecord)
      .sort(
        (left, right) =>
          left.layer.localeCompare(right.layer) ||
          left.name.localeCompare(right.name) ||
          left.path.localeCompare(right.path),
      ),
    scriptsError: workspaceScriptsError,
  };
}

export async function loadAutomationScriptSource({
  request,
  context,
  orgId,
  scriptId,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  orgId: string;
  scriptId: string;
}): Promise<AutomationScriptSourceRecord> {
  const fileSystem = await createBackofficeAutomationFileSystem({ request, context, orgId });

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

export async function fetchAutomationStoreEntries(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
): Promise<{
  storeEntries: AutomationStoreEntryRecord[];
  storeEntriesError: string | null;
}> {
  try {
    const callRoute = createAutomationsRouteCaller(request, context, orgId);
    const requestUrl = new URL(request.url);
    const prefix = requestUrl.searchParams.get("prefix") ?? undefined;
    const response = await callRoute("GET", "/store", {
      query: typeof prefix === "string" ? { prefix } : {},
    });

    if (response.type === "json" && isSuccessStatus(response.status)) {
      return {
        storeEntries: toRecordArray<AutomationStoreEntryRecord>(response.data),
        storeEntriesError: null,
      };
    }

    if (response.type === "error") {
      return {
        storeEntries: [],
        storeEntriesError: response.error.message,
      };
    }

    return {
      storeEntries: [],
      storeEntriesError: `Failed to fetch automation store entries (${response.status}).`,
    };
  } catch (error) {
    return {
      storeEntries: [],
      storeEntriesError: formatErrorMessage(error, "Failed to load automation store entries."),
    };
  }
}

export async function fetchAutomationProjects(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
): Promise<{
  projects: AutomationProjectRecord[];
  projectsError: string | null;
}> {
  try {
    const callRoute = createAutomationsRouteCaller(request, context, orgId);
    const response = await callRoute("GET", "/projects");

    if (response.type === "json" && isSuccessStatus(response.status)) {
      return {
        projects: toRecordArray<AutomationProjectRecord>(response.data),
        projectsError: null,
      };
    }

    if (response.type === "error") {
      return {
        projects: [],
        projectsError: response.error.message,
      };
    }

    return {
      projects: [],
      projectsError: `Failed to fetch automation projects (${response.status}).`,
    };
  } catch (error) {
    return {
      projects: [],
      projectsError: formatErrorMessage(error, "Failed to load automation projects."),
    };
  }
}

export async function createAutomationProject(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  input: {
    name: string;
    slug?: string;
    description?: string | null;
    createdByUserId: string;
  },
): Promise<{ project: AutomationProjectRecord | null; error: string | null }> {
  try {
    const callRoute = createAutomationsRouteCaller(request, context, orgId);
    const response = await callRoute("POST", "/projects", { body: input });

    if (response.type === "json" && isSuccessStatus(response.status)) {
      return { project: response.data as AutomationProjectRecord, error: null };
    }

    if (response.type === "error") {
      return { project: null, error: response.error.message };
    }

    return { project: null, error: `Failed to create automation project (${response.status}).` };
  } catch (error) {
    return {
      project: null,
      error: formatErrorMessage(error, "Failed to create automation project."),
    };
  }
}

export async function updateAutomationProject(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  projectId: string,
  input: {
    name?: string;
    slug?: string;
    description?: string | null;
  },
): Promise<{ project: AutomationProjectRecord | null; error: string | null }> {
  try {
    const callRoute = createAutomationsRouteCaller(request, context, orgId);
    const response = await callRoute("PATCH", "/projects/:projectId", {
      pathParams: { projectId },
      body: input,
    });

    if (response.type === "json" && isSuccessStatus(response.status)) {
      return { project: response.data as AutomationProjectRecord, error: null };
    }

    if (response.type === "error") {
      return { project: null, error: response.error.message };
    }

    return { project: null, error: `Failed to update automation project (${response.status}).` };
  } catch (error) {
    return {
      project: null,
      error: formatErrorMessage(error, "Failed to update automation project."),
    };
  }
}

export async function archiveAutomationProject(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  projectId: string,
): Promise<{ project: AutomationProjectRecord | null; error: string | null }> {
  try {
    const callRoute = createAutomationsRouteCaller(request, context, orgId);
    const response = await callRoute("DELETE", "/projects/:projectId", {
      pathParams: { projectId },
    });

    if (response.type === "json" && isSuccessStatus(response.status)) {
      return { project: response.data as AutomationProjectRecord, error: null };
    }

    if (response.type === "error") {
      return { project: null, error: response.error.message };
    }

    return { project: null, error: `Failed to archive automation project (${response.status}).` };
  } catch (error) {
    return {
      project: null,
      error: formatErrorMessage(error, "Failed to archive automation project."),
    };
  }
}

export async function deleteAutomationStoreEntry(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  key: string,
): Promise<{
  ok: boolean;
  error: string | null;
}> {
  try {
    const callRoute = createAutomationsRouteCaller(request, context, orgId);
    const response = await callRoute("POST", "/store/delete", {
      body: { key },
    });

    return booleanActionResultFromRouteResponse({
      response,
      failureMessage: "Failed to delete automation store entry",
      requireSuccessStatus: true,
    });
  } catch (error) {
    return booleanActionResultFromCaughtError(error, "Failed to delete automation store entry.");
  }
}
