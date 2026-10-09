import type { createRouteCaller } from "@fragno-dev/core/api";

import type { GitHubObject, GitHubWebhookRouterObject } from "@/backoffice-runtime/object-registry";
import type { GitHubFragment } from "@/fragno/github";
import { isSuccessStatus } from "@/fragno/runtime-tools/runtime-errors";

type GitHubCallRoute = ReturnType<typeof createRouteCaller<GitHubFragment>>;

/** Redirect notices the configuration page shows after GitHub returns from an install. */
type GitHubInstallCallbackOutcome =
  | "installed_synced"
  | "installed_other_account"
  | "installed_pending_webhook"
  | "expired_state"
  | "user_mismatch"
  | "invalid_state"
  | "callback_error";

/**
 * Completes GitHub's install redirect: binds the installation to the organization, syncs its
 * repositories, and links the repositories that integration setup requested with this install.
 */
export async function completeGitHubInstallCallback({
  router,
  github,
  callRoute,
  userId,
  organizationId,
  state,
  installationId,
}: {
  router: Pick<GitHubWebhookRouterObject, "consumeInstallState" | "setInstallationOrg">;
  github: Pick<GitHubObject, "redeliverFailedInstallationWebhooks">;
  callRoute: GitHubCallRoute;
  userId: string;
  organizationId: string;
  state: string;
  installationId: string;
}): Promise<GitHubInstallCallbackOutcome> {
  const consumed = await router.consumeInstallState({ state, userId, installationId });
  if (!consumed.ok) {
    console.warn("GitHub install callback state validation failed", {
      organizationId,
      installationId,
      userId,
      code: consumed.code,
      message: consumed.message,
    });
    switch (consumed.code) {
      case "EXPIRED_STATE":
        return "expired_state";
      case "USER_MISMATCH":
        return "user_mismatch";
      case "INVALID_STATE":
        return "invalid_state";
      default:
        throw new Error("Unknown GitHub install state failure.", {
          cause: consumed.code satisfies never,
        });
    }
  }
  if (consumed.orgId !== organizationId) {
    console.warn("GitHub install callback resolved to a different organization", {
      requestedOrgId: organizationId,
      resolvedOrgId: consumed.orgId,
      installationId,
      userId,
    });
    return "callback_error";
  }

  const mapping = await router.setInstallationOrg(installationId, organizationId);
  if (!mapping.ok) {
    console.error("GitHub install callback failed to map installation to organization", {
      organizationId,
      installationId,
      userId,
      code: mapping.code,
      existingOrgId: mapping.existingOrgId,
      error: mapping.message,
    });
    return "callback_error";
  }

  const synced = await callRoute("POST", "/installations/:installationId/sync", {
    pathParams: { installationId },
  }).then(
    (response) =>
      response.type === "json" && isSuccessStatus(response.status)
        ? null
        : `HTTP ${response.status}`,
    (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
  );
  if (synced !== null) {
    console.warn("GitHub install callback mapped installation but sync failed", {
      organizationId,
      installationId,
      error: synced,
    });
    // Requested repositories stay unlinked; setup asks for them again once webhooks arrive.
    await github.redeliverFailedInstallationWebhooks(installationId);
    return "installed_pending_webhook";
  }

  const request = consumed.repositoryRequest;
  if (request === null) {
    return "installed_synced";
  }
  const account = await callRoute("GET", "/installations").then(
    (response) =>
      response.type === "json" && isSuccessStatus(response.status)
        ? (response.data.find((installation) => installation.id === installationId)?.accountLogin ??
          null)
        : null,
    () => null,
  );
  // The user picks the account on GitHub's page; another account cannot reach the requested
  // repositories, and setup offers a fresh link for the requested account.
  if (account !== null && account !== request.owner) {
    console.warn("GitHub install callback installed a different account than setup requested", {
      organizationId,
      installationId,
      requestedAccount: request.owner,
      installedAccount: account,
    });
    return "installed_other_account";
  }

  for (const fullName of request.repositories) {
    const slash = fullName.indexOf("/");
    const linked = await callRoute("POST", "/repositories/:owner/:repo/link", {
      pathParams: { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) },
      body: {},
    }).then(
      (response) =>
        response.type === "json" && isSuccessStatus(response.status)
          ? null
          : `HTTP ${response.status}`,
      (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
    );
    // The installation is already bound and synced, so a repository the user left out on GitHub,
    // or a failed link, leaves only that repository for setup to report as not granted.
    if (linked !== null) {
      console.warn("GitHub install callback could not link a requested repository", {
        organizationId,
        installationId,
        repository: fullName,
        error: linked,
      });
    }
  }
  return "installed_synced";
}
