import { createRouteCaller } from "@fragno-dev/core/api";
import { createFetchFragnoOutboxTransport } from "@fragno-dev/tanstack-db-adapter/transport";
import type { RouterContextProvider } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { createBackofficeFileSystem } from "@/files";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import {
  getAutomationLayerForPath,
  listAutomationWorkspaceScripts,
  readAutomationWorkspaceScript,
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
  AutomationProjectRecord,
  AutomationScriptRecord,
  AutomationScriptSourceRecord,
} from "./data";
import {
  buildAutomationScriptRecord,
  fromAutomationScriptId,
  isAutomationScriptLayerVisibleInScope,
} from "./script-records";

type AutomationFragment = ReturnType<typeof createAutomationFragment>;

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

  const transport = createFetchFragnoOutboxTransport({
    internalUrl: url,
    fetch: (input, init) =>
      automationsDo.fetch(new Request(input, { ...init, headers: request.headers })),
  });

  return transport.getAdapterIdentity({ signal: request.signal });
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

export { toExternalId } from "./data";

export async function loadAutomationWorkspaceData({
  request,
  context,
  scope,
  orgId,
  layers,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  scope?: BackofficeContextScope;
  orgId?: string;
  layers?: readonly AutomationWorkspaceScriptEntry["layer"][];
}): Promise<{
  scripts: AutomationScriptRecord[];
  scriptsError: string | null;
}> {
  const resolvedScope = scope ?? (orgId ? { kind: "org" as const, orgId } : null);
  if (!resolvedScope) {
    throw new Error("Automation scope is required.");
  }
  if (layers?.length === 0) {
    return { scripts: [], scriptsError: null };
  }

  const fileSystem = await createBackofficeAutomationFileSystem({
    request,
    context,
    scope: resolvedScope,
  });

  let workspaceScripts: AutomationWorkspaceScriptEntry[] = [];
  let workspaceScriptsError: string | null = null;
  try {
    workspaceScripts = await listAutomationWorkspaceScripts(fileSystem, { layers });
  } catch (error) {
    workspaceScriptsError = formatErrorMessage(error, "Failed to list automation scripts.");
  }

  const scripts: AutomationScriptRecord[] = [];
  for (const workspaceScript of workspaceScripts) {
    if (isAutomationScriptLayerVisibleInScope(workspaceScript.layer, resolvedScope)) {
      scripts.push(buildAutomationScriptRecord(workspaceScript));
    }
  }
  scripts.sort(
    (left, right) =>
      left.layer.localeCompare(right.layer) ||
      left.name.localeCompare(right.name) ||
      left.path.localeCompare(right.path),
  );

  return {
    scripts,
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
