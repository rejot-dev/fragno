import { Outlet, redirect, useOutletContext } from "react-router";

import { getBackofficeMe } from "@/fragno/auth/auth-server";
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

// Force the server middleware to run for client navigations to internals routes without loaders.
export function loader() {
  return null;
}

export default function BackofficeInternalsLayout() {
  const backofficeContext = useOutletContext<BackofficeLayoutContext>();
  return <Outlet context={backofficeContext} />;
}
