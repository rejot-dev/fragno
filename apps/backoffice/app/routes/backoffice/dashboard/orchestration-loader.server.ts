import type { RouterContextProvider } from "react-router";

import {
  backofficePersonalScope,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import { fetchAutomationReplicaSource } from "@/fragno/automation/lofi/replica-source.server";
import { loadAutomationProjectList } from "@/fragno/automation/project-list.server";
import { runtimeToolWorkflowCatalog } from "@/fragno/runtime-tools/workflow-catalog.server";
import {
  getBackofficeShellRequest,
  requireRouteScope,
  requireScopeSelection,
} from "@/layouts/backoffice-shell-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { loadAutomationScriptSource } from "../automations/data.server";
import type { OrchestrationLoaderData } from "./orchestration-panel";
import type { OrchestrationUniverseScopes } from "./orchestration-universe-panel";
import { WORKFLOW_SCRIPT_PARAM, dashboardMapView } from "./path";

const EMPTY_WORKFLOW_SOURCE = { script: null, scriptError: null };

/**
 * The organization's projects and the person looking, each with where its replica is served, which
 * the universe opens beside the organization's. A scope that cannot be described is left out and
 * named.
 */
async function loadUniverseScopes(
  request: Request,
  context: Readonly<RouterContextProvider>,
  organization: Extract<BackofficeScopeSelection, { kind: "org" }>,
): Promise<OrchestrationUniverseScopes> {
  const [viewer, list] = await Promise.all([
    loadUniverseViewer(request, context),
    loadAutomationProjectList(request, context.get(BackofficeWorkerContext), organization),
  ]);
  if (list.kind === "failed") {
    return { projects: [], viewer: viewer.scope, problems: [list.message, ...viewer.problems] };
  }
  const described = await Promise.allSettled(
    list.projects.map(async (project) => ({
      label: project.name,
      source: await fetchAutomationReplicaSource(request, context, {
        kind: "project",
        owner: { kind: "org", organization: organization.organization },
        project: { id: project.id, slug: project.slug },
      }),
    })),
  );
  return {
    projects: described.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
    viewer: viewer.scope,
    problems: [
      ...described.flatMap((result, index) =>
        result.status === "rejected" ? [`${list.projects[index]?.name} could not be read.`] : [],
      ),
      ...viewer.problems,
    ],
  };
}

/** The person looking, whose personal scope they can read; none before onboarding creates it. */
async function loadUniverseViewer(
  request: Request,
  context: Readonly<RouterContextProvider>,
): Promise<{ scope: OrchestrationUniverseScopes["viewer"]; problems: string[] }> {
  const { user } = getBackofficeShellRequest(context).me;
  const personalScope = backofficePersonalScope(user);
  if (personalScope === null) {
    return { scope: null, problems: [] };
  }
  try {
    const source = await fetchAutomationReplicaSource(request, context, {
      kind: "user",
      userId: personalScope.userId,
      jurisdiction: personalScope.jurisdiction,
    });
    return { scope: { label: user.name || user.email, source }, problems: [] };
  } catch {
    return { scope: null, problems: ["Your personal scope could not be read."] };
  }
}

/**
 * What the orchestration panel reads from the server: the scope it graphs, the source of the
 * workflow selected in the URL, the tools workflows can call, and, when an organization's Map shows
 * its universe, the projects beside it.
 */
export async function loadOrchestration({
  request,
  context,
  url,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  url: URL;
}): Promise<OrchestrationLoaderData> {
  const selectedScope = requireScopeSelection(context);
  const workflowScriptId = url.searchParams.get(WORKFLOW_SCRIPT_PARAM)?.trim() ?? "";
  return {
    selectedScope,
    workflowSource: workflowScriptId
      ? await loadAutomationScriptSource({
          context,
          execution: requireRouteScope(context).execution,
          scriptId: workflowScriptId,
        })
      : EMPTY_WORKFLOW_SOURCE,
    runtimeToolCatalog: runtimeToolWorkflowCatalog,
    universe:
      selectedScope.kind === "org" && dashboardMapView(url.searchParams) === "universe"
        ? await loadUniverseScopes(request, context, selectedScope)
        : null,
  };
}
