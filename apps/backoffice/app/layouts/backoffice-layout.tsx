import "../backoffice.css";

import { redirect } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { BackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import { BackofficeScopeCodecError } from "@/backoffice-runtime/scope-codec";
import type { CurrentBackofficeContext } from "@/components/backoffice/current-context";
import { getBackofficeMe } from "@/fragno/auth/auth-server";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { fetchAutomationCollectionSource } from "@/fragno/automation/tanstack/server";
import {
  buildBackofficeAuthBootstrapPath,
  buildBackofficeOrganizationSwitchPath,
} from "@/routes/backoffice/auth-navigation";

import type { Route } from "./+types/backoffice-layout";
import { resolveCurrentBackofficeScope } from "./backoffice-layout-scope";
import BackofficeLayout, { ErrorBoundary } from "./backoffice-layout-ui";

export { ErrorBoundary };

export default function BackofficeLayoutRoute(props: Route.ComponentProps) {
  return <BackofficeLayout {...props} />;
}

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  if (import.meta.env.MODE !== "development") {
    throw new Response("Not Found", { status: 404 });
  }

  const returnTo = `${url.pathname}${url.search}`;
  const jwtMe = await getBackofficeMe(request, context);
  if (jwtMe.status !== "authenticated") {
    throw redirect(buildBackofficeAuthBootstrapPath(returnTo));
  }
  const me = jwtMe.me;
  const accessTokenExpiresAt = jwtMe.expiresAt.toISOString();

  const defaultOrganizationId =
    me.activeOrganization?.organization.id ?? me.organizations[0]?.organization.id ?? null;
  const defaultScope = defaultOrganizationId
    ? { kind: "org" as const, orgId: defaultOrganizationId }
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
  const destinationOrganizationId =
    currentScope.kind === "org" || currentScope.kind === "project" ? currentScope.orgId : null;
  if (
    destinationOrganizationId &&
    destinationOrganizationId !== me.activeOrganizationId &&
    me.organizations.some(({ organization }) => organization.id === destinationOrganizationId)
  ) {
    throw redirect(buildBackofficeOrganizationSwitchPath(destinationOrganizationId, returnTo));
  }

  try {
    await requireBackofficeContext(request, context, currentScope);
  } catch (error) {
    if (error instanceof BackofficeForbiddenError) {
      throw new Response(error.message, { status: 403 });
    }
    throw error;
  }

  const automationCollectionSourcePromise = fetchAutomationCollectionSource(
    request,
    context,
    currentScope,
  ).then(
    (source): CurrentBackofficeContext["automationCollectionSource"] => ({
      status: "ready",
      source,
    }),
    (error: unknown): CurrentBackofficeContext["automationCollectionSource"] => ({
      status: "unavailable",
      message: error instanceof Error ? error.message : "Workflow synchronization is unavailable.",
    }),
  );
  const projectCollectionSourcePromise: Promise<
    CurrentBackofficeContext["projectCollectionSource"]
  > | null =
    currentScope.kind === "org"
      ? automationCollectionSourcePromise
      : currentScope.kind === "project"
        ? fetchAutomationCollectionSource(request, context, {
            kind: "org",
            orgId: currentScope.orgId,
          }).then(
            (source): CurrentBackofficeContext["automationCollectionSource"] => ({
              status: "ready",
              source,
            }),
            (error: unknown): CurrentBackofficeContext["automationCollectionSource"] => ({
              status: "unavailable",
              message:
                error instanceof Error ? error.message : "Project synchronization is unavailable.",
            }),
          )
        : null;
  const [automationCollectionSource, projectCollectionSource] = await Promise.all([
    automationCollectionSourcePromise,
    projectCollectionSourcePromise,
  ]);

  return {
    me,
    accessTokenExpiresAt,
    currentScope,
    automationCollectionSource,
    projectCollectionSource,
  };
}

export type BackofficeLayoutContext = {
  me: NonNullable<Route.ComponentProps["loaderData"]["me"]>;
};
