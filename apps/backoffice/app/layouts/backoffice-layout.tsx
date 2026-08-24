import "../backoffice.css";

import { redirect } from "react-router";

import { BackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import {
  backofficeRuntimeScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { isBackofficeScopeCodecError } from "@/backoffice-runtime/scope-codec";
import type { CurrentBackofficeContext } from "@/components/backoffice/current-context";
import { getBackofficeMe } from "@/fragno/auth/auth-server";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import type { Organization } from "@/fragno/auth/contracts";
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

  const activeOrganization = me.activeOrganization?.organization ?? null;
  if (
    me.activeOrganizationId &&
    (!activeOrganization || activeOrganization.id !== me.activeOrganizationId)
  ) {
    throw redirect(buildBackofficeAuthBootstrapPath(returnTo));
  }
  const defaultScope: BackofficeResolvedScope<Organization> = activeOrganization
    ? { kind: "org", organization: activeOrganization }
    : { kind: "user", userId: me.user.id };
  let resolvedScope: BackofficeResolvedScope<Organization>;
  try {
    resolvedScope = resolveCurrentBackofficeScope({
      params,
      defaultScope,
      organizations: me.organizations.map(({ organization }) => organization),
    });
  } catch (error) {
    if (isBackofficeScopeCodecError(error)) {
      resolvedScope = defaultScope;
    } else {
      throw error;
    }
  }
  const runtimeScope = backofficeRuntimeScopeFromResolvedScope(resolvedScope);
  const destinationOrganizationId =
    resolvedScope.kind === "org" || resolvedScope.kind === "project"
      ? resolvedScope.organization.id
      : null;
  if (
    destinationOrganizationId &&
    destinationOrganizationId !== me.activeOrganizationId &&
    me.organizations.some(({ organization }) => organization.id === destinationOrganizationId)
  ) {
    throw redirect(buildBackofficeOrganizationSwitchPath(destinationOrganizationId, returnTo));
  }

  try {
    await requireBackofficeContext(request, context, runtimeScope);
  } catch (error) {
    if (error instanceof BackofficeForbiddenError) {
      throw new Response(error.message, { status: 403 });
    }
    throw error;
  }

  const automationCollectionSourcePromise = fetchAutomationCollectionSource(
    request,
    context,
    resolvedScope,
  ).then(
    (source): CurrentBackofficeContext["automationCollectionSource"] => ({
      status: "ready",
      source,
    }),
    (error: unknown): CurrentBackofficeContext["automationCollectionSource"] => ({
      status: "unavailable",
      resolvedScope,
      message: error instanceof Error ? error.message : "Workflow synchronization is unavailable.",
    }),
  );
  const projectCollectionSourcePromise: Promise<
    CurrentBackofficeContext["projectCollectionSource"]
  > | null =
    resolvedScope.kind === "org"
      ? automationCollectionSourcePromise
      : resolvedScope.kind === "project"
        ? fetchAutomationCollectionSource(request, context, {
            kind: "org",
            organization: resolvedScope.organization,
          }).then(
            (source): CurrentBackofficeContext["automationCollectionSource"] => ({
              status: "ready",
              source,
            }),
            (error: unknown): CurrentBackofficeContext["automationCollectionSource"] => ({
              status: "unavailable",
              resolvedScope: {
                kind: "org",
                organization: resolvedScope.organization,
              },
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
    automationCollectionSource,
    projectCollectionSource,
  };
}

export type BackofficeLayoutContext = {
  me: NonNullable<Route.ComponentProps["loaderData"]["me"]>;
};
