import "@fragno-private/design-system/components.css";

import { backofficeScopeProjectOwner } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { CurrentBackofficeContext } from "@/components/backoffice/current-context-state";
import { fetchAutomationReplicaSource } from "@/fragno/automation/lofi/replica-source.server";
import { loadAutomationProjectList } from "@/fragno/automation/project-list.server";
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

  return {
    me,
    accessTokenExpiresAt,
    resolvedScope,
    administeredMember,
    automationReplicaSource,
    projectList,
  };
}

export type BackofficeLayoutContext = {
  me: NonNullable<Route.ComponentProps["loaderData"]["me"]>;
};
