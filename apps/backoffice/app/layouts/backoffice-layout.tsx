import "../backoffice.css";

import { redirect } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { BackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import { BackofficeScopeCodecError } from "@/backoffice-runtime/scope-codec";
import type { CurrentBackofficeContext } from "@/components/backoffice/current-context";
import { getAuthMe } from "@/fragno/auth/auth-server";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { fetchAutomationCollectionSource } from "@/fragno/automation/tanstack/server";
import { buildBackofficeLoginPath } from "@/routes/backoffice/auth-navigation";

import type { Route } from "./+types/backoffice-layout";
import { resolveCurrentBackofficeScope } from "./backoffice-layout-scope";

export { default, ErrorBoundary } from "./backoffice-layout-ui";

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  if (import.meta.env.MODE !== "development") {
    throw new Response("Not Found", { status: 404 });
  }

  const returnTo = `${url.pathname}${url.search}`;
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    throw redirect(buildBackofficeLoginPath(returnTo));
  }

  if (!me.activeOrganization && me.organizations.length > 0) {
    throw redirect(buildBackofficeLoginPath(returnTo));
  }

  const defaultScope = me.activeOrganization?.organization.id
    ? { kind: "org" as const, orgId: me.activeOrganization.organization.id }
    : { kind: "user" as const, userId: me.user.id };
  let currentScope: BackofficeContextScope;
  try {
    currentScope = resolveCurrentBackofficeScope({ params, defaultScope });
  } catch (error) {
    if (error instanceof BackofficeScopeCodecError) {
      throw new Response("Not Found", { status: 404 });
    }
    throw error;
  }
  try {
    await requireBackofficeContext(request, context, currentScope);
  } catch (error) {
    if (error instanceof BackofficeForbiddenError) {
      throw new Response(error.message, { status: 403 });
    }
    throw error;
  }

  const automationCollectionSource: CurrentBackofficeContext["automationCollectionSource"] =
    await fetchAutomationCollectionSource(request, context, currentScope).then(
      (source) => ({ status: "ready", source }),
      (error: unknown) => ({
        status: "unavailable",
        message:
          error instanceof Error ? error.message : "Workflow synchronization is unavailable.",
      }),
    );
  return { me, currentScope, automationCollectionSource };
}

export type BackofficeLayoutContext = {
  me: NonNullable<Route.ComponentProps["loaderData"]["me"]>;
};
