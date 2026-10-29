import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { BackofficeTabHeader } from "@fragno-private/design-system/tab-header";
import { Outlet, useLocation, useOutletContext } from "react-router";

import {
  backofficeRouteScopeFromResolvedScope,
  backofficeRuntimeScopeFromResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import type { BackofficeRouteScope } from "@/backoffice-runtime/route-scope";
import { backofficePageBodyClassName } from "@/components/backoffice/page-body";
import type { BackofficeLayoutContext } from "@/layouts/backoffice-layout";
import {
  getBackofficeShellRequest,
  requireRouteScope,
} from "@/layouts/backoffice-shell-request.server";

import { isBackofficeSystemAdministrator } from "../scope-labels";
import type { Route } from "./+types/layout";
import { internalsScopeBasePath } from "./internals-scope";

export const middleware: Route.MiddlewareFunction[] = [
  ({ context }) => {
    if (!isBackofficeSystemAdministrator(getBackofficeShellRequest(context).me.user)) {
      throw new Response("Not Found", { status: 404 });
    }
  },
];

export type InternalsLayoutContext = BackofficeLayoutContext & {
  selectedScope: BackofficeContextScope;
  selectedRouteScope: BackofficeRouteScope;
};

// Force the server middleware to run for client navigations to internals routes without loaders.
export function loader({ context }: Route.LoaderArgs) {
  const { resolvedScope } = requireRouteScope(context);
  return {
    selectedScope: backofficeRuntimeScopeFromResolvedScope(resolvedScope),
    selectedRouteScope: backofficeRouteScopeFromResolvedScope(resolvedScope),
  };
}

// Paths are relative to the scope's Internals root; the overview is the root itself.
const INTERNALS_TABS = [
  { id: "overview", label: "Overview", path: "" },
  { id: "users", label: "Users", path: "/users" },
  { id: "access-codes", label: "Access codes", path: "/access-codes" },
  { id: "github", label: "GitHub", path: "/github" },
  { id: "browser-run", label: "Browser Run", path: "/cloudflare/browser-run" },
  { id: "generated-ui", label: "Generated UI", path: "/generated-ui" },
  { id: "durable-hooks", label: "Durable hooks", path: "/durable-hooks" },
  { id: "codemode", label: "Codemode runs", path: "/codemode" },
  { id: "workflows", label: "Workflows", path: "/workflows" },
] as const;

export default function BackofficeInternalsLayout({ loaderData }: Route.ComponentProps) {
  const backofficeContext = useOutletContext<BackofficeLayoutContext>();
  const pathname = useLocation().pathname.replace(/\/+$/, "");
  const basePath = internalsScopeBasePath(loaderData.selectedRouteScope);

  return (
    <div className="flex flex-1 flex-col">
      <h1 className="sr-only">Internals</h1>
      <BackofficeTabHeader
        items={INTERNALS_TABS.map((tab) => ({
          id: tab.id,
          label: tab.label,
          to: `${basePath}${tab.path}`,
          active:
            tab.path === ""
              ? pathname === basePath
              : pathname === `${basePath}${tab.path}` ||
                pathname.startsWith(`${basePath}${tab.path}/`),
        }))}
        ariaLabel="Internals tools"
        trailing={null}
        options={null}
      />
      <div className={`${backofficePageBodyClassName} flex flex-col gap-4`}>
        <Outlet context={{ ...backofficeContext, ...loaderData }} />
      </div>
    </div>
  );
}
