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
// How many members' names the universe names planets with; it shows few members as planets.
const UNIVERSE_MEMBER_NAMES = 200;

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
  const [viewer, list, members] = await Promise.all([
    loadUniverseViewer(request, context),
    loadAutomationProjectList(request, context.get(BackofficeWorkerContext), organization),
    loadUniverseMemberNames(context, organization.organization.id),
  ]);
  if (list.kind === "failed") {
    return {
      projects: [],
      viewer: viewer.scope,
      memberNames: members.names,
      problems: [list.message, ...viewer.problems, ...members.problems],
    };
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
    memberNames: members.names,
    problems: [
      ...described.flatMap((result, index) =>
        result.status === "rejected" ? [`${list.projects[index]?.name} could not be read.`] : [],
      ),
      ...viewer.problems,
      ...members.problems,
    ],
  };
}

/**
 * The names of the organization's members, by user ID: their name, or their email without one.
 * The oldest members come first; members past them go without, and their planets by their scope.
 * When the directory does not answer, nobody is named, and the universe says why.
 */
export async function loadUniverseMemberNames(
  context: Readonly<RouterContextProvider>,
  organizationId: string,
): Promise<{ names: Record<string, string>; problems: string[] }> {
  try {
    const { members } = await context
      .get(BackofficeWorkerContext)
      .runtime.objects.auth.singleton()
      .commands.listOrganizationMembersByPage({
        organizationId,
        page: 1,
        pageSize: UNIVERSE_MEMBER_NAMES,
      });
    return {
      names: Object.fromEntries(members.map(({ userId, name, email }) => [userId, name || email])),
      problems: [],
    };
  } catch (error) {
    return {
      names: {},
      problems: [
        `Members' names could not be read, so their planets go by their scopes: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
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
