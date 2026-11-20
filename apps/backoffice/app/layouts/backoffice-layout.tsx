import "@fragno-private/design-system/components.css";

import {
  backofficeScopeOrganization,
  backofficeScopeProjectOwner,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import {
  type BackofficeNamedProject,
  backofficePublicScopeFromRuntimeScope,
  type BackofficeResolvedScope,
  backofficeRuntimeScopeFromResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { backofficePublicScopePathSegment } from "@/backoffice-runtime/route-scope";
import type { CurrentBackofficeContext } from "@/components/backoffice/current-context-state";
import type { ScopeProbe } from "@/components/backoffice/scope-probe";
import type { Organization } from "@/fragno/auth/contracts";
import { fetchAutomationReplicaSource } from "@/fragno/automation/lofi/replica-source.server";
import { loadAutomationProjectList } from "@/fragno/automation/project-list.server";
import {
  type BackofficeRequestState,
  getBackofficeRequestState,
} from "@/worker-runtime/request-state";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/backoffice-layout";
import { establishBackofficeAuthenticatedRequest } from "./backoffice-authenticated-request.server";
import BackofficeLayout, { ErrorBoundary } from "./backoffice-layout-ui";
import { recordBackofficePresence } from "./backoffice-presence.server";
import {
  establishBackofficeShellRequest,
  getBackofficeShellRequest,
} from "./backoffice-shell-request.server";

export { ErrorBoundary };

export const middleware: Route.MiddlewareFunction[] = [
  establishBackofficeAuthenticatedRequest,
  establishBackofficeShellRequest,
  recordBackofficePresence,
];

export default function BackofficeLayoutRoute(props: Route.ComponentProps) {
  return <BackofficeLayout {...props} />;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const shellRequest = getBackofficeShellRequest(context);
  const { me, resolvedScope, administeredMember } = shellRequest;
  const accessTokenExpiresAt = shellRequest.accessTokenExpiresAt.toISOString();

  // The project menu lists the projects beside the workspace, which their owner stores. Only the
  // menu waits for them, so they stream in after the page renders.
  const projectOwner = backofficeScopeProjectOwner(resolvedScope);
  const projectList = projectOwner
    ? loadAutomationProjectList(request, context.get(BackofficeWorkerContext), projectOwner)
    : null;
  // Streamed like the project menu, so checking the flag never holds up the page.
  const scopeProbe = loadScopeProbe(getBackofficeRequestState(context), resolvedScope);
  const automationReplicaSource = await fetchAutomationReplicaSource(
    request,
    context,
    resolvedScope,
  ).then(
    (source): CurrentBackofficeContext["automationReplicaSource"] => ({
      status: "ready",
      source,
    }),
    (error: unknown): CurrentBackofficeContext["automationReplicaSource"] => ({
      status: "unavailable",
      resolvedScope,
      message: error instanceof Error ? error.message : "Workflow synchronization is unavailable.",
    }),
  );

  const { config } = context.get(BackofficeWorkerContext).runtime;
  return {
    me,
    accessTokenExpiresAt,
    resolvedScope,
    administeredMember,
    automationReplicaSource,
    projectList,
    scopeProbe,
    sitesDomain: config.sites ? config.sitesDomain : null,
  };
}

/** Names the scope whose override turned `scope-probe` on, as `admin.feature-flags` addresses it. */
async function loadScopeProbe(
  requestState: BackofficeRequestState,
  resolvedScope: BackofficeResolvedScope<Organization, BackofficeNamedProject>,
): Promise<ScopeProbe> {
  return await requestState
    .getFeatureFlag(backofficeRuntimeScopeFromResolvedScope(resolvedScope), "scope-probe")
    .then(
      ({ value, overrides: [deciding] }): ScopeProbe => {
        if (!value) {
          return { kind: "off" };
        }
        if (!deciding) {
          return { kind: "on", decidedBy: "default" };
        }
        const organization = backofficeScopeOrganization(resolvedScope)?.organization ?? null;
        return {
          kind: "on",
          decidedBy:
            deciding.scope.kind === "system"
              ? "system"
              : backofficePublicScopePathSegment(
                  backofficePublicScopeFromRuntimeScope(deciding.scope, organization),
                ),
        };
      },
      // The probe exists to check flags, so it shows a failure rather than hiding.
      (error: unknown): ScopeProbe => ({
        kind: "failed",
        message: error instanceof Error ? error.message : "Feature flags are unavailable.",
      }),
    );
}

export type BackofficeLayoutContext = {
  me: NonNullable<Route.ComponentProps["loaderData"]["me"]>;
};
