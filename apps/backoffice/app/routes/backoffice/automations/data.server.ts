import type { RouterContextProvider } from "react-router";

import { extractW3CRequestPropagationContext } from "@fragno-dev/core";

import type {
  BackofficeContextScope,
  BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import { createBackofficeFileSystem } from "@/files";
import { getAutomationLayerForPath, readAutomationWorkspaceScript } from "@/fragno/automation";
import { createAutomationsRouteCaller } from "@/fragno/automation/route-callers";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { booleanActionResultFromCaughtError } from "../action-result";
import type { AutomationProjectRecord, AutomationScriptSourceRecord } from "./data";
import { fromAutomationScriptId, isAutomationScriptLayerVisibleInScope } from "./script-records";

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

async function createBackofficeAutomationFileSystem({
  context,
  execution,
}: {
  context: Readonly<RouterContextProvider>;
  execution: BackofficeExecutionContext;
}) {
  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  return createBackofficeFileSystem({
    objects: runtime.objects,
    kernel,
    execution,
    config: runtime.config,
  });
}

export { toExternalId } from "./data";

export async function loadAutomationScriptSource({
  context,
  execution,
  scriptId,
}: {
  context: Readonly<RouterContextProvider>;
  execution: BackofficeExecutionContext;
  scriptId: string;
}): Promise<AutomationScriptSourceRecord> {
  const fileSystem = await createBackofficeAutomationFileSystem({ context, execution });

  try {
    const scriptPath = fromAutomationScriptId(scriptId);
    const layer = getAutomationLayerForPath(scriptPath);
    if (!isAutomationScriptLayerVisibleInScope(layer, execution.scope)) {
      return {
        script: null,
        scriptError: `Automation script '${scriptPath}' is not visible in ${execution.scope.kind} scope.`,
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

type AutomationProjectLookupResult =
  | { status: "found"; project: AutomationProjectRecord }
  | { status: "not-found" }
  | { status: "error"; message: string };

/** Looks up one project only when a server boundary must validate a project-scoped request. */
export async function lookupAutomationProject(
  context: Readonly<RouterContextProvider>,
  orgId: string,
  projectId: string,
): Promise<AutomationProjectLookupResult> {
  try {
    const callRoute = createAutomationsRouteCaller({
      object: getScopedAutomationsObject(context, { kind: "org", orgId }),
    });
    const response = await callRoute("GET", "/projects/:projectId", {
      pathParams: { projectId },
    });

    if (response.type === "json" && isSuccessStatus(response.status)) {
      return { status: "found", project: response.data as AutomationProjectRecord };
    }
    if (response.status === 404) {
      return { status: "not-found" };
    }
    if (response.type === "error") {
      return { status: "error", message: response.error.message };
    }
    return {
      status: "error",
      message: `Failed to look up automation project (${response.status}).`,
    };
  } catch (error) {
    return {
      status: "error",
      message: formatErrorMessage(error, "Failed to look up automation project."),
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
  execution: BackofficeExecutionContext,
  key: string,
): Promise<{
  ok: boolean;
  error: string | null;
}> {
  try {
    const { runtime, kernel } = context.get(BackofficeWorkerContext);
    const automations = kernel.scoped("AUTOMATIONS", execution.scope, runtime.objects.automations);
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
