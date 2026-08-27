import { Outlet, redirect, useOutletContext } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import {
  backofficeRuntimeScopeFromResolvedScope,
  resolveBackofficeRouteScope,
} from "@/backoffice-runtime/resolved-scope";
import {
  requireBackofficeRouteScopeFromParams,
  type BackofficeRouteScope,
} from "@/backoffice-runtime/route-scope";
import { getBackofficeMe, requireBackofficeMe } from "@/fragno/auth/auth-server";
import type { BackofficeLayoutContext } from "@/layouts/backoffice-layout";

import { buildBackofficeAuthBootstrapPath } from "../auth-navigation";
import type { Route } from "./+types/layout";

export const middleware: Route.MiddlewareFunction[] = [
  async ({ request, context }) => {
    const authentication = await getBackofficeMe(request, context);
    if (authentication.status !== "authenticated") {
      const url = new URL(request.url);
      throw redirect(buildBackofficeAuthBootstrapPath(`${url.pathname}${url.search}`));
    }

    if (authentication.me.user.role !== "admin") {
      throw new Response("Not Found", { status: 404 });
    }
  },
];

export type InternalsLayoutContext = BackofficeLayoutContext & {
  selectedScope: BackofficeContextScope;
  selectedRouteScope: BackofficeRouteScope;
};

// Force the server middleware to run for client navigations to internals routes without loaders.
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const me = await requireBackofficeMe(request, context);
  let selectedRouteScope: BackofficeRouteScope;
  try {
    selectedRouteScope = requireBackofficeRouteScopeFromParams(params);
  } catch {
    throw new Response("Not Found", { status: 404 });
  }

  const resolvedScope = resolveBackofficeRouteScope(
    selectedRouteScope,
    me.organizations.map(({ organization }) => organization),
  );
  if (!resolvedScope || (resolvedScope.kind === "user" && resolvedScope.userId !== me.user.id)) {
    throw new Response("Not Found", { status: 404 });
  }

  return {
    selectedScope: backofficeRuntimeScopeFromResolvedScope(resolvedScope),
    selectedRouteScope,
  };
}

export default function BackofficeInternalsLayout({ loaderData }: Route.ComponentProps) {
  const backofficeContext = useOutletContext<BackofficeLayoutContext>();
  return <Outlet context={{ ...backofficeContext, ...loaderData }} />;
}
