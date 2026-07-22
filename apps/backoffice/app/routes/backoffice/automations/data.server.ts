import { createRouteCaller } from "@fragno-dev/core/api";
import type { RouterContextProvider } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { createBackofficeFileSystem } from "@/files";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import {
  AUTOMATION_STATIC_ROOT,
  AUTOMATION_SYSTEM_ROOT,
  AUTOMATION_WORKSPACE_ROOT,
  getAutomationLayerForPath,
  listAutomationWorkspaceScripts,
  readAutomationWorkspaceScript,
  type AutomationEventDefinition,
  type AutomationWorkspaceScriptEntry,
  type createAutomationFragment,
} from "@/fragno/automation";
import { writeAutomationScript } from "@/fragno/automation/authoring";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import {
  booleanActionResultFromCaughtError,
  booleanActionResultFromRouteResponse,
} from "../action-result";
import type {
  AutomationEventRecord,
  AutomationProjectRecord,
  AutomationRouteRecord,
  AutomationScriptRecord,
  AutomationScriptSourceRecord,
  AutomationStoreEntryRecord,
} from "./data";

type AutomationFragment = ReturnType<typeof createAutomationFragment>;

const AUTOMATION_SCRIPT_ID_PREFIX = "automation-script:";
export type AutomationEventsResult = {
  events: AutomationEventRecord[];
  cursor?: string;
  hasNextPage: boolean;
  eventsError: string | null;
};

export type AutomationEventDefinitionsResult = {
  eventDefinitions: AutomationEventDefinition[];
  eventDefinitionsError: string | null;
};

const formatErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

const isSuccessStatus = (status: number) => status >= 200 && status < 300;

const scopeOrgId = (scope: BackofficeContextScope) => {
  if (scope.kind === "org" || scope.kind === "project") {
    return scope.orgId;
  }
  return undefined;
};

const applyAutomationScopeQuery = (url: URL, scope: BackofficeContextScope) => {
  const orgId = scopeOrgId(scope);
  url.searchParams.set("scopeKind", scope.kind);
  if (orgId) {
    url.searchParams.set("orgId", orgId);
  }
  if (scope.kind === "project") {
    url.searchParams.set("projectId", scope.projectId);
  }
  if (scope.kind === "user") {
    url.searchParams.set("userId", scope.userId);
  }
};

const getScopedAutomationsObject = (
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
) => {
  const { runtime } = context.get(BackofficeWorkerContext);
  const kernel = new BackofficeKernel({ objects: runtime.objects });
  return kernel.scoped("AUTOMATIONS", scope, runtime.objects.automations);
};

const createAutomationsRouteCaller = (
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
) => {
  const automationsDo = getScopedAutomationsObject(context, scope);
  return createRouteCaller<AutomationFragment>({
    baseUrl: request.url,
    mountRoute: "/api/automations",
    baseHeaders: request.headers,
    fetch: async (outboundRequest) => {
      const url = new URL(outboundRequest.url);
      applyAutomationScopeQuery(url, scope);
      return automationsDo.fetch(new Request(url.toString(), outboundRequest));
    },
  });
};

export async function fetchAutomationAdapterIdentity(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
): Promise<string> {
  const automationsDo = getScopedAutomationsObject(context, scope);
  const url = new URL(request.url);
  url.pathname = "/api/automations/_internal";
  url.search = "";
  applyAutomationScopeQuery(url, scope);

  const response = await automationsDo.fetch(
    new Request(url, {
      method: "GET",
      headers: request.headers,
    }),
  );
  if (!response.ok) {
    throw new Error(
      `Failed to load automation adapter identity (${response.status} ${response.statusText}).`,
    );
  }

  const description: unknown = await response.json();
  if (
    typeof description !== "object" ||
    description === null ||
    !("adapterIdentity" in description) ||
    typeof description.adapterIdentity !== "string"
  ) {
    throw new Error("Automation internal description did not include an adapter identity.");
  }

  return description.adapterIdentity;
}

const toRecordArray = <T extends Record<string, unknown>>(value: unknown): T[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is T => Boolean(item) && typeof item === "object");
};

const createBackofficeAutomationFileSystem = async ({
  request,
  context,
  scope,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  scope: BackofficeContextScope;
}) => {
  const { runtime } = context.get(BackofficeWorkerContext);
  const kernel = new BackofficeKernel({ objects: runtime.objects });
  const execution = await requireBackofficeContext(request, context, scope);
  return createBackofficeFileSystem({
    objects: runtime.objects,
    kernel,
    execution,
    config: runtime.config,
  });
};

const normalizeAutomationScriptPath = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  for (const root of [AUTOMATION_STATIC_ROOT, AUTOMATION_SYSTEM_ROOT, AUTOMATION_WORKSPACE_ROOT]) {
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

const isAutomationScriptLayerVisibleInScope = (
  layer: AutomationWorkspaceScriptEntry["layer"],
  scope: BackofficeContextScope,
) => {
  if (scope.kind === "system") {
    return layer === "system";
  }
  if (layer === "static") {
    return scope.kind === "org";
  }
  return layer === "workspace";
};

const buildWorkspaceScriptRecord = (
  script: AutomationWorkspaceScriptEntry,
): AutomationScriptRecord => ({
  id: toAutomationScriptId(script),
  layer: script.layer,
  readOnly: script.layer === "static" || script.layer === "system",
  key: buildAutomationScriptKey(script.path),
  name: buildAutomationScriptName(script.path),
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

  if (layer === "static") {
    return `${AUTOMATION_STATIC_ROOT}/${path}`;
  }
  if (layer === "system") {
    return `${AUTOMATION_SYSTEM_ROOT}/${path}`;
  }
  if (layer === "workspace") {
    return `${AUTOMATION_WORKSPACE_ROOT}/${path}`;
  }

  return path;
};

export { toExternalId } from "./data";

export async function loadAutomationWorkspaceData({
  request,
  context,
  scope,
  orgId,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  scope?: BackofficeContextScope;
  orgId?: string;
}): Promise<{
  scripts: AutomationScriptRecord[];
  scriptsError: string | null;
}> {
  const resolvedScope = scope ?? (orgId ? { kind: "org" as const, orgId } : null);
  if (!resolvedScope) {
    throw new Error("Automation scope is required.");
  }
  const fileSystem = await createBackofficeAutomationFileSystem({
    request,
    context,
    scope: resolvedScope,
  });

  let workspaceScripts: AutomationWorkspaceScriptEntry[] = [];
  let workspaceScriptsError: string | null = null;
  try {
    workspaceScripts = await listAutomationWorkspaceScripts(fileSystem);
  } catch (error) {
    workspaceScriptsError = formatErrorMessage(error, "Failed to list automation scripts.");
  }

  return {
    scripts: workspaceScripts
      .filter((script) => isAutomationScriptLayerVisibleInScope(script.layer, resolvedScope))
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

/**
 * Persist an edited automation script body back to its file, validating it first.
 * System-layer scripts are read-only and rejected by `writeAutomationScript`.
 */
export async function writeAutomationScriptSource({
  request,
  context,
  scope,
  orgId,
  absolutePath,
  body,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  scope?: BackofficeContextScope;
  orgId?: string;
  absolutePath: string;
  body: string;
}): Promise<{ ok: boolean; error: string | null }> {
  const resolvedScope = scope ?? (orgId ? { kind: "org" as const, orgId } : null);
  if (!resolvedScope) {
    throw new Error("Automation scope is required.");
  }
  const fileSystem = await createBackofficeAutomationFileSystem({
    request,
    context,
    scope: resolvedScope,
  });

  const result = await writeAutomationScript(fileSystem, { path: absolutePath, body });
  return { ok: result.ok, error: result.ok ? null : (result.error ?? null) };
}

export async function loadAutomationScriptSource({
  request,
  context,
  scope,
  orgId,
  scriptId,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  scope?: BackofficeContextScope;
  orgId?: string;
  scriptId: string;
}): Promise<AutomationScriptSourceRecord> {
  const resolvedScope = scope ?? (orgId ? { kind: "org" as const, orgId } : null);
  if (!resolvedScope) {
    throw new Error("Automation scope is required.");
  }
  const fileSystem = await createBackofficeAutomationFileSystem({
    request,
    context,
    scope: resolvedScope,
  });

  try {
    const scriptPath = fromAutomationScriptId(scriptId);
    const layer = getAutomationLayerForPath(scriptPath);
    if (!isAutomationScriptLayerVisibleInScope(layer, resolvedScope)) {
      return {
        script: null,
        scriptError: `Automation script '${scriptPath}' is not visible in ${resolvedScope.kind} scope.`,
      };
    }

    const script = await readAutomationWorkspaceScript(fileSystem, scriptPath);
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

export async function fetchAutomationRoutes(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
): Promise<{
  routes: AutomationRouteRecord[];
  routesError: string | null;
}> {
  try {
    const callRoute = createAutomationsRouteCaller(request, context, scope);
    const response = await callRoute("GET", "/routes");

    if (response.type === "json" && isSuccessStatus(response.status)) {
      return {
        routes: toRecordArray<AutomationRouteRecord>(response.data),
        routesError: null,
      };
    }

    if (response.type === "error") {
      return {
        routes: [],
        routesError: response.error.message,
      };
    }

    return {
      routes: [],
      routesError: `Failed to fetch automation routes (${response.status}).`,
    };
  } catch (error) {
    return {
      routes: [],
      routesError: formatErrorMessage(error, "Failed to load automation routes."),
    };
  }
}

export async function fetchAutomationStoreEntries(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
): Promise<{
  storeEntries: AutomationStoreEntryRecord[];
  storeEntriesError: string | null;
}> {
  try {
    const callRoute = createAutomationsRouteCaller(request, context, scope);
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

export async function fetchAutomationEventDefinitions(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
): Promise<AutomationEventDefinitionsResult> {
  try {
    const callRoute = createAutomationsRouteCaller(request, context, scope);
    const response = await callRoute("GET", "/event-definitions");

    if (response.type === "json" && isSuccessStatus(response.status)) {
      return {
        eventDefinitions: toRecordArray<AutomationEventDefinition>(response.data),
        eventDefinitionsError: null,
      };
    }

    if (response.type === "error") {
      return {
        eventDefinitions: [],
        eventDefinitionsError: response.error.message,
      };
    }

    return {
      eventDefinitions: [],
      eventDefinitionsError: `Failed to fetch automation event definitions (${response.status}).`,
    };
  } catch (error) {
    return {
      eventDefinitions: [],
      eventDefinitionsError: formatErrorMessage(
        error,
        "Failed to load automation event definitions.",
      ),
    };
  }
}

export async function fetchAutomationEvents(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  options: { limit?: number; cursor?: string } = {},
): Promise<AutomationEventsResult> {
  try {
    const callRoute = createAutomationsRouteCaller(request, context, scope);
    const response = await callRoute("GET", "/events", {
      query: {
        ...(typeof options.limit === "number" ? { limit: String(options.limit) } : {}),
        ...(options.cursor ? { cursor: options.cursor } : {}),
      },
    });

    if (response.type === "json" && isSuccessStatus(response.status)) {
      const data = response.data as {
        events?: unknown;
        nextCursor?: unknown;
        hasNextPage?: unknown;
      };
      return {
        events: toRecordArray<AutomationEventRecord>(data.events),
        cursor: typeof data.nextCursor === "string" ? data.nextCursor : undefined,
        hasNextPage: data.hasNextPage === true,
        eventsError: null,
      };
    }

    if (response.type === "error") {
      return {
        events: [],
        hasNextPage: false,
        eventsError: response.error.message,
      };
    }

    return {
      events: [],
      hasNextPage: false,
      eventsError: `Failed to fetch automation events (${response.status}).`,
    };
  } catch (error) {
    return {
      events: [],
      hasNextPage: false,
      eventsError: formatErrorMessage(error, "Failed to load automation events."),
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
    const callRoute = createAutomationsRouteCaller(request, context, { kind: "org", orgId });
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
    const callRoute = createAutomationsRouteCaller(request, context, { kind: "org", orgId });
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
    const callRoute = createAutomationsRouteCaller(request, context, { kind: "org", orgId });
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
    const callRoute = createAutomationsRouteCaller(request, context, { kind: "org", orgId });
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
  scope: BackofficeContextScope,
  key: string,
): Promise<{
  ok: boolean;
  error: string | null;
}> {
  try {
    const callRoute = createAutomationsRouteCaller(request, context, scope);
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
