import { backofficeRuntimeScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { findBackofficeMe } from "@/fragno/auth/auth-server";

import { runBackofficeTerminalAction } from "../terminal.server";
import type { Route } from "./+types/terminal-command";
import { lookupAutomationProject } from "./data.server";
import { automationRuntimeScopeFromRouteParams, resolveAutomationScopeSelection } from "./scope";

export async function action({ request, context, params }: Route.ActionArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    throw new Response("Authentication required", { status: 401 });
  }

  const parsedScope = automationRuntimeScopeFromRouteParams(
    params,
    me.organizations.map(({ organization }) => organization),
  );
  const organizations = me.organizations.map((entry) => entry.organization);
  const projectLookup =
    parsedScope.kind === "project"
      ? await lookupAutomationProject(context, parsedScope.orgId, parsedScope.projectId)
      : null;
  if (projectLookup?.status === "error") {
    throw Response.json(
      {
        code: "AUTOMATION_PROJECT_UNAVAILABLE",
        message: projectLookup.message,
      },
      { status: 502, statusText: "Bad Gateway" },
    );
  }
  if (projectLookup?.status === "not-found") {
    throw new Response("Not Found", { status: 404 });
  }

  const selectedScope = resolveAutomationScopeSelection({
    params,
    organizations,
    project: projectLookup?.status === "found" ? projectLookup.project : null,
    user: me.user,
  });

  return runBackofficeTerminalAction({
    request,
    context,
    scope: backofficeRuntimeScopeFromResolvedScope(selectedScope),
  });
}
