import { useOutletContext } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";

import { DashboardTerminalPanel } from "../dashboard-terminal-panel";
import {
  BACKOFFICE_TERMINAL_COMMAND_GROUPS,
  BACKOFFICE_TERMINAL_COMMAND_SPECS,
} from "../terminal-commands";
import { runBackofficeTerminalAction } from "../terminal.server";
import type { Route } from "./+types/terminal";
import { fetchAutomationProjects } from "./data.server";
import {
  automationScopeBasePath,
  automationScopeFromRouteParams,
  resolveAutomationUiScope,
  toBackofficeScope,
} from "./scope";
import type { AutomationLayoutContext } from "./shared";

export async function action({ request, context, params }: Route.ActionArgs) {
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    throw new Response("Authentication required", { status: 401 });
  }

  const parsedScope = automationScopeFromRouteParams(params);
  const organisations = me.organizations.map((entry) => entry.organization);
  const projectsResult =
    parsedScope.kind === "project" || parsedScope.kind === "org"
      ? await fetchAutomationProjects(request, context, parsedScope.orgId)
      : { projects: [], projectsError: null };

  if (parsedScope.kind === "project" && projectsResult.projectsError) {
    throw Response.json(
      {
        code: "AUTOMATION_PROJECTS_UNAVAILABLE",
        message: projectsResult.projectsError,
      },
      { status: 502, statusText: "Bad Gateway" },
    );
  }

  const selectedScope = resolveAutomationUiScope({
    params,
    organisations,
    projects: projectsResult.projects,
    user: me.user,
  });

  return runBackofficeTerminalAction({
    request,
    context,
    scope: toBackofficeScope(selectedScope),
  });
}

export default function BackofficeAutomationTerminal() {
  const { selectedScope } = useOutletContext<AutomationLayoutContext>();
  const scopePath = automationScopeBasePath(selectedScope);

  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
      <DashboardTerminalPanel
        key={scopePath}
        scopeId={scopePath}
        scopeName={selectedScope.label}
        commandSpecs={BACKOFFICE_TERMINAL_COMMAND_SPECS}
        description={`Commands run in the ${selectedScope.label} ${selectedScope.kind} scope and use its scoped backoffice filesystem and runtime tools.`}
      />

      <div className="space-y-4">
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
            Selected scope
          </p>
          <p className="mt-2 text-lg font-semibold text-[var(--bo-fg)]">{selectedScope.label}</p>
          <p className="mt-2 text-sm text-[var(--bo-muted)]">
            Switching the scope picker above moves this terminal to that scope automatically.
          </p>
        </div>

        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
            Supported quick checks
          </p>
          <ul className="mt-2 space-y-2 text-sm text-[var(--bo-muted)]">
            <li>• ls, cat, find, pwd</li>
            <li>• isogit clone / status</li>
            {BACKOFFICE_TERMINAL_COMMAND_GROUPS.map((group) => (
              <li key={group.namespace}>
                • {group.namespace}: {group.commands.join(" / ")}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
