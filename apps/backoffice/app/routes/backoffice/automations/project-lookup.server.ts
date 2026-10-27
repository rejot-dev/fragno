import type {
  BackofficeProjectOwner,
  BackofficeScopeIdNames,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { RouterContextProvider } from "react-router";

import { createAutomationsRouteCaller } from "@/fragno/automation/route-callers";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { AutomationProjectRecord } from "./data";

// Kept apart from `data.server.ts`, whose script-source readers load the static files and the upload
// index, so the Backoffice layout looks up a page's project without loading them.

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
    const { runtime, kernel } = context.get(BackofficeWorkerContext);
    const callRoute = createAutomationsRouteCaller({
      object: kernel.scoped("AUTOMATIONS", owner, runtime.objects.automations),
    });
    const response =
      "slug" in project
        ? await callRoute("GET", "/projects/by-slug/:slug", { pathParams: { slug: project.slug } })
        : await callRoute("GET", "/projects/:projectId", {
            pathParams: { projectId: project.projectId },
          });

    if (response.type === "json" && response.status >= 200 && response.status < 300) {
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
      message: error instanceof Error ? error.message : "Failed to look up automation project.",
    };
  }
}
