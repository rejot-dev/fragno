import type { RouterContextProvider } from "react-router";

import { extractW3CRequestPropagationContext } from "@fragno-dev/core";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { BackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import { createBackofficeFileSystem } from "@/files";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import {
  getAutomationLayerForPath,
  listAutomationWorkspaceScripts,
  readAutomationWorkspaceScript,
  type AutomationWorkspaceScriptEntry,
} from "@/fragno/automation";
import { createAutomationsRouteCaller } from "@/fragno/automation/route-callers";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { booleanActionResultFromCaughtError } from "../action-result";
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

const formatErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

const isSuccessStatus = (status: number) => status >= 200 && status < 300;

const rethrowHttpResponseOrForbiddenError = (error: unknown) => {
  if (error instanceof Response) {
    throw error;
  }
  if (error instanceof BackofficeForbiddenError) {
    throw new Response(error.message, { status: 403 });
  }
};

const getScopedAutomationsObject = (
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
) => {
  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  return kernel.scoped("AUTOMATIONS", scope, runtime.objects.automations);
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
  scope,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  scope: BackofficeContextScope;
}) => {
  const { runtime, kernel } = context.get(BackofficeWorkerContext);
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
  context: Readonly<RouterContextProvider>,
  orgId: string,
): Promise<{
  projects: AutomationProjectRecord[];
  projectsError: string | null;
}> {
  try {
    const callRoute = createAutomationsRouteCaller({
      object: getScopedAutomationsObject(context, { kind: "org", orgId }),
    });
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
    const callRoute = createAutomationsRouteCaller({
      object: getScopedAutomationsObject(context, { kind: "org", orgId }),
    });
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
    const { runtime, kernel } = context.get(BackofficeWorkerContext);
    const execution = await requireBackofficeContext(request, context, scope);
    const automations = kernel.scoped("AUTOMATIONS", scope, runtime.objects.automations);
    const callRoute = createAutomationsRouteCaller({
      object: automations,
      context: {
        execution,
        propagationContext: extractW3CRequestPropagationContext(request.headers),
      },
    });
    const response = await callRoute("POST", "/store/delete", { body: { key } });

    if (response.type === "json" && isSuccessStatus(response.status)) {
      return { ok: true, error: null };
    }
    if (response.type === "error") {
      if (response.status === 401 || response.status === 403 || response.status === 503) {
        throw Response.json(response.error, { status: response.status });
      }
      return { ok: false, error: response.error.message };
    }
    return { ok: false, error: `Failed to delete automation store entry (${response.status}).` };
  } catch (error) {
    rethrowHttpResponseOrForbiddenError(error);
    return booleanActionResultFromCaughtError(error, "Failed to delete automation store entry.");
  }
}
