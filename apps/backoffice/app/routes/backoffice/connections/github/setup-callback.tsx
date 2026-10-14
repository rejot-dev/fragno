import { redirect } from "react-router";

import { findBackofficeMe } from "@/fragno/auth/auth-server";
import { getGitHubWebhookRouterDurableObject } from "@/worker-runtime/durable-objects";

import { buildBackofficeLoginPath } from "../../auth-navigation";
import { integrationOAuthReturn } from "../../integrations/connection-paths";
import {
  integrationBasePath,
  integrationScopeSelectionFromRuntimeScope,
} from "../../integrations/scope";
import type { Route } from "./+types/setup-callback";

const toStatePreview = (value: string) => (value ? `${value.slice(0, 8)}…` : "");

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    return redirect(buildBackofficeLoginPath(`${url.pathname}${url.search}`));
  }
  // Without usable state the installation's organization is unknown, so the failure is reported
  // in the organization the user is working in.
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

  const scope = { kind: "org" as const, orgId: resolved.orgId };
  const targetPath = `${integrationBasePath(integrationScopeSelectionFromRuntimeScope(scope, me), "github")}/configuration`;
  const search = url.searchParams.toString();
  return redirect(search ? `${targetPath}?${search}` : targetPath);
}
