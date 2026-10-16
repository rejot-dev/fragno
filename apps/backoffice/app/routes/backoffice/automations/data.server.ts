import type {
  BackofficeContextScope,
  BackofficeProjectOwner,
  BackofficeScopeIdNames,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { RouterContextProvider } from "react-router";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { getAutomationLayerForPath, readAutomationScript } from "@/fragno/automation";
import { readBackofficeAutomationSource } from "@/fragno/automation/read-backoffice-automation-source";
import { createAutomationsRouteCaller } from "@/fragno/automation/route-callers";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { AutomationProjectRecord, AutomationScriptSourceRecord } from "./data";
import { fromAutomationScriptId, isAutomationScriptLayerVisibleInScope } from "./script-records";

const formatErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

const isSuccessStatus = (status: number) => status >= 200 && status < 300;

const getScopedAutomationsObject = (
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
) => {
  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  return kernel.scoped("AUTOMATIONS", scope, runtime.objects.automations);
};

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
  const { runtime, kernel } = context.get(BackofficeWorkerContext);

  try {
    const scriptPath = fromAutomationScriptId(scriptId);
    const layer = getAutomationLayerForPath(scriptPath);
    if (!isAutomationScriptLayerVisibleInScope(layer, execution.scope)) {
      return {
        script: null,
        scriptError: `Automation script '${scriptPath}' is not visible in ${execution.scope.kind} scope.`,
      };
    }

    const script = await readAutomationScript(
      ({ path }) =>
        readBackofficeAutomationSource({
          objects: runtime.objects,
          kernel,
          execution,
          config: runtime.config,
          path,
        }),
      { execution, scriptPath },
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

type AutomationProjectLookupResult =
  | { status: "found"; project: AutomationProjectRecord }
  | { status: "not-found" }
  | { status: "error"; message: string };

/** Looks up one project only when a server boundary must validate a project-scoped request. */
export async function lookupAutomationProject(
  context: Readonly<RouterContextProvider>,
  owner: BackofficeProjectOwner<BackofficeScopeIdNames>,
  project: { projectId: string } | { slug: string },
): Promise<AutomationProjectLookupResult> {
  try {
    // Projects are stored with their owner.
    const callRoute = createAutomationsRouteCaller({
      object: getScopedAutomationsObject(context, owner),
    });
    const response =
      "slug" in project
        ? await callRoute("GET", "/projects/by-slug/:slug", { pathParams: { slug: project.slug } })
        : await callRoute("GET", "/projects/:projectId", {
            pathParams: { projectId: project.projectId },
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
  owner: BackofficeProjectOwner<BackofficeScopeIdNames>,
  input: {
    name: string;
    slug?: string;
    description?: string | null;
    createdByUserId: string;
  },
): Promise<{ project: AutomationProjectRecord | null; error: string | null }> {
  try {
    const callRoute = createAutomationsRouteCaller({
      object: getScopedAutomationsObject(context, owner),
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
