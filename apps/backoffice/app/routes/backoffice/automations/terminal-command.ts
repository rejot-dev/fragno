import { getAuthMe } from "@/fragno/auth/auth-server";

import { runBackofficeTerminalAction } from "../terminal.server";
import type { Route } from "./+types/terminal-command";
import { lookupAutomationProject } from "./data.server";
import {
  automationScopeFromRouteParams,
  resolveAutomationUiScope,
  toBackofficeScope,
} from "./scope";

export async function action({ request, context, params }: Route.ActionArgs) {
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    throw new Response("Authentication required", { status: 401 });
  }

  const parsedScope = automationScopeFromRouteParams(params);
  const organisations = me.organizations.map((entry) => entry.organization);
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

  const selectedScope = resolveAutomationUiScope({
    params,
    organisations,
    project: projectLookup?.status === "found" ? projectLookup.project : null,
    user: me.user,
  });

  return runBackofficeTerminalAction({
    request,
    context,
    scope: toBackofficeScope(selectedScope),
  });
}
