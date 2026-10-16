import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { Outlet, useOutletContext } from "react-router";

import {
  backofficeRouteScopeFromResolvedScope,
  backofficeRuntimeScopeFromResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import type { BackofficeRouteScope } from "@/backoffice-runtime/route-scope";
import type { BackofficeLayoutContext } from "@/layouts/backoffice-layout";
import {
  getBackofficeShellRequest,
  requireRouteScope,
} from "@/layouts/backoffice-shell-request.server";

import { isBackofficeSystemAdministrator } from "../scope-labels";
import type { Route } from "./+types/layout";

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

export default function BackofficeInternalsLayout({ loaderData }: Route.ComponentProps) {
  const backofficeContext = useOutletContext<BackofficeLayoutContext>();
  return <Outlet context={{ ...backofficeContext, ...loaderData }} />;
}
