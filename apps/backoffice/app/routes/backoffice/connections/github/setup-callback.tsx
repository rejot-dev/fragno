import { redirect } from "react-router";

import {
  backofficeRouteScopePath,
  type BackofficeRouteScope,
} from "@/backoffice-runtime/route-scope";
import type { BackofficeMeData } from "@/fragno/auth/contracts";
import type { GitHubInstallationOwner } from "@/fragno/github";
import { getBackofficeShellRequest } from "@/layouts/backoffice-shell-request.server";
import { getGitHubWebhookRouterDurableObject } from "@/worker-runtime/durable-objects";

import { integrationOAuthReturn } from "../../integrations/connection-paths";
import type { Route } from "./+types/setup-callback";

const toStatePreview = (value: string) => (value ? `${value.slice(0, 8)}…` : "");

/**
 * How page URLs name the installing workspace, or null for an organization the user left. A
 * personal workspace is named by its user, and its pages decide who may enter it.
 */
function installingWorkspace(
  me: BackofficeMeData,
  owner: GitHubInstallationOwner,
): BackofficeRouteScope | null {
  if (owner.kind === "user") {
    return { kind: "user", userId: owner.userId };
  }
  const organization = me.organizations.find(
    (entry) => entry.organization.id === owner.orgId,
  )?.organization;
  return organization ? { kind: "org", orgSlug: organization.slug } : null;
}

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const { me } = getBackofficeShellRequest(context);
  // Without usable state the installation's workspace is unknown, so the failure is reported in
  // the organization the user is working in.
  const reportFailure = (message: string) => {
    const organization = me.activeOrganization?.organization;
    return organization
      ? integrationOAuthReturn({
          request,
          routeScope: { kind: "org", orgSlug: organization.slug },
          connectionId: null,
          outcome: { status: "error", message },
        })
      : redirect("/backoffice/integrations");
  };
  const state = url.searchParams.get("state")?.trim() ?? "";
  if (!state) {
    console.warn("GitHub setup callback called without state", {
      userId: me.user.id,
    });
    return reportFailure("GitHub returned without install state. Start the install again.");
  }

  const githubWebhookRouterDo = getGitHubWebhookRouterDurableObject(context);
  const resolved = await githubWebhookRouterDo.commands.resolveInstallState({
    state,
    userId: me.user.id,
  });
  if (!resolved.ok) {
    console.warn("GitHub setup callback failed to resolve install state", {
      code: resolved.code,
      message: resolved.message,
      userId: me.user.id,
      state: toStatePreview(state),
    });
    return reportFailure(resolved.message);
  }

  const workspace = installingWorkspace(me, resolved.owner);
  if (!workspace) {
    return reportFailure("The installing organization is no longer available.");
  }
  const targetPath = `/backoffice/integrations/${backofficeRouteScopePath(workspace)}/github/configuration`;
  const search = url.searchParams.toString();
  return redirect(search ? `${targetPath}?${search}` : targetPath);
}
