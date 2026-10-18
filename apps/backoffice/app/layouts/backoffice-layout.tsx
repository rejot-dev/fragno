import "@fragno-private/design-system/components.css";

import type { CurrentBackofficeContext } from "@/components/backoffice/current-context-state";
import { fetchAutomationCollectionSource } from "@/fragno/automation/tanstack/server";

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
  const { me, resolvedScope } = shellRequest;
  const accessTokenExpiresAt = shellRequest.accessTokenExpiresAt.toISOString();

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
    // The project menu lists the projects beside the workspace, which their owner stores.
    resolvedScope.kind === "system"
      ? null
      : resolvedScope.kind === "project"
        ? fetchAutomationCollectionSource(request, context, resolvedScope.owner).then(
            (source): CurrentBackofficeContext["automationCollectionSource"] => ({
              status: "ready",
              source,
            }),
            (error: unknown): CurrentBackofficeContext["automationCollectionSource"] => ({
              status: "unavailable",
              resolvedScope: resolvedScope.owner,
              message:
                error instanceof Error ? error.message : "Project synchronization is unavailable.",
            }),
          )
        : automationCollectionSourcePromise;
  const [automationCollectionSource, projectCollectionSource] = await Promise.all([
    automationCollectionSourcePromise,
    projectCollectionSourcePromise,
  ]);

  return {
    me,
    accessTokenExpiresAt,
    resolvedScope,
    automationCollectionSource,
    projectCollectionSource,
  };
}

export type BackofficeLayoutContext = {
  me: NonNullable<Route.ComponentProps["loaderData"]["me"]>;
};
