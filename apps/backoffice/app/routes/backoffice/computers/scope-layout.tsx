import { BackofficePageHeader } from "@fragno-private/design-system/page-header";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { BackofficeTabHeader } from "@fragno-private/design-system/tab-header";
import { isRouteErrorResponse, Outlet } from "react-router";

import { backofficeRouteScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { backofficePageBodyClassName } from "@/components/backoffice/page-body";
import { requireScopeSelection } from "@/layouts/backoffice-shell-request.server";

import { getRouteErrorMessage } from "../route-errors";
import type { Route } from "./+types/scope-layout";
import type { ComputersLayoutContext } from "./layout-context";
import { sandboxesPath } from "./paths";

export async function loader({ context }: Route.LoaderArgs) {
  return { selectedScope: requireScopeSelection(context) };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Computers · ${loaderData?.selectedScope.label ?? "scope"}` }];
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const statusCode = isRouteErrorResponse(error) ? error.status : 500;
  const statusText = isRouteErrorResponse(error) ? error.statusText || "Error" : "Error";

  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[
          { label: "Backoffice", to: "/backoffice" },
          { label: "Computers", to: "/backoffice/computers" },
          { label: "Error" },
        ]}
        eyebrow="Computers"
        title="Computers unavailable"
        description="The requested scope could not be opened."
      />
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
          {statusCode} · {statusText}
        </p>
        <p className="mt-2 text-[var(--bo-fg)]">
          {getRouteErrorMessage(error, "An unexpected error occurred.")}
        </p>
      </div>
    </div>
  );
}

export default function BackofficeComputersScopeLayout({ loaderData }: Route.ComponentProps) {
  const { selectedScope } = loaderData;
  const routeScope = backofficeRouteScopeFromResolvedScope(selectedScope);

  // Computers run on behalf of an organization, project, or person, never the system.
  if (routeScope.kind === "system") {
    return (
      <div className="flex flex-1 flex-col">
        <h1 className="sr-only">Computers</h1>
        <BackofficeSystemState
          tone="empty"
          label="Unavailable"
          title="The system scope has no computers."
          description="Switch to an organization, project, or your personal scope to manage its computers."
          flush
        />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <h1 className="sr-only">Computers for {selectedScope.label}</h1>
      <BackofficeTabHeader
        items={[
          { id: "sandboxes", label: "Sandboxes", to: sandboxesPath(routeScope), active: true },
        ]}
        ariaLabel="Computer kinds"
        options={null}
      />
      <div className={`${backofficePageBodyClassName} flex flex-1 flex-col`}>
        <Outlet context={{ routeScope } satisfies ComputersLayoutContext} />
      </div>
    </div>
  );
}
