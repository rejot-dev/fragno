import { redirect } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";
import { getGitHubWebhookRouterDurableObject } from "@/worker-runtime/durable-objects";

import { buildBackofficeLoginPath } from "../../auth-navigation";
import { integrationBasePath, scopeToAutomationUiScope } from "../../integrations/scope";
import type { Route } from "./+types/setup-callback";

const CONNECTIONS_INDEX_PATH = "/backoffice/connections/github";
const toStatePreview = (value: string) => (value ? `${value.slice(0, 8)}…` : "");

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return redirect(buildBackofficeLoginPath(`${url.pathname}${url.search}`));
  }
  const state = url.searchParams.get("state")?.trim() ?? "";
  if (!state) {
    console.warn("GitHub setup callback called without state", {
      userId: me.user.id,
    });
    return redirect(CONNECTIONS_INDEX_PATH);
  }

  const githubWebhookRouterDo = getGitHubWebhookRouterDurableObject(context);
  const resolved = await githubWebhookRouterDo.resolveInstallState({
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
    return redirect(CONNECTIONS_INDEX_PATH);
  }

  const scope = { kind: "org" as const, orgId: resolved.orgId };
  const targetPath = `${integrationBasePath(scopeToAutomationUiScope(scope, me), "github")}/configuration`;
  const search = url.searchParams.toString();
  return redirect(search ? `${targetPath}?${search}` : targetPath);
}
