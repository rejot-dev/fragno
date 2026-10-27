import {
  backofficeContextScopesEqual,
  backofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { createRouteCaller } from "@fragno-dev/core/api";

import type {
  GitHubCommands,
  GitHubWebhookRouterCommands,
} from "@/backoffice-runtime/object-registry";
import type { GitHubFragment, GitHubInstallationOwner } from "@/fragno/github";
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
 * Completes GitHub's install redirect: binds the installation to the workspace, syncs its
 * repositories, and links the repositories that integration setup requested with this install.
 */
export async function completeGitHubInstallCallback({
  router,
  github,
  callRoute,
  userId,
  owner,
  state,
  installationId,
}: {
  router: Pick<GitHubWebhookRouterCommands, "consumeInstallState" | "setInstallationOwner">;
  github: Pick<GitHubCommands, "redeliverFailedInstallationWebhooks">;
  callRoute: GitHubCallRoute;
  userId: string;
  owner: GitHubInstallationOwner;
  state: string;
  installationId: string;
}): Promise<GitHubInstallCallbackOutcome> {
  const ownerSegment = backofficeScopePathSegment(owner);
  const consumed = await router.consumeInstallState({ state, userId, installationId });
  if (!consumed.ok) {
    console.warn("GitHub install callback state validation failed", {
      owner: ownerSegment,
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
  if (!backofficeContextScopesEqual(consumed.owner, owner)) {
    console.warn("GitHub install callback resolved to a different workspace", {
      requestedOwner: ownerSegment,
      resolvedOwner: backofficeScopePathSegment(consumed.owner),
      installationId,
      userId,
    });
    return "callback_error";
  }

  const mapping = await router.setInstallationOwner(installationId, owner);
  if (!mapping.ok) {
    console.error("GitHub install callback failed to map installation to workspace", {
      owner: ownerSegment,
      installationId,
      userId,
      code: mapping.code,
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
      owner: ownerSegment,
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
      owner: ownerSegment,
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
        owner: ownerSegment,
        installationId,
        repository: fullName,
        error: linked,
      });
    }
  }
  return "installed_synced";
}
