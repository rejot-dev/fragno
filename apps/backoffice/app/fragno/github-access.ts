import {
  backofficeContextScopesEqual,
  backofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { createRouteCaller } from "@fragno-dev/core/api";
import type {
  GitHubRepositoryInstallRequest,
  GitHubSignInPurpose,
} from "workers/github-webhook-router-object";
import { z } from "zod";

import type {
  GitHubCommands,
  GitHubWebhookRouterCommands,
} from "@/backoffice-runtime/object-registry";
import type { GitHubFragment, GitHubInstallationOwner } from "@/fragno/github";
import { isSuccessStatus } from "@/fragno/runtime-tools/runtime-errors";

export type { GitHubSignInPurpose };

export type GitHubCallRoute = ReturnType<typeof createRouteCaller<GitHubFragment>>;
type GitHubRouteResponse = Awaited<ReturnType<GitHubCallRoute>>;

export const gitHubUserInstallationSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  accountLogin: z.string(),
  accountType: z.string(),
  htmlUrl: z.string().nullable(),
});

/** An installation of the app, as GitHub lists the ones a signed-in user reaches. */
export type GitHubUserInstallation = z.output<typeof gitHubUserInstallationSchema>;

const signInStartSchema = z.object({
  state: z.string(),
  authorizationUrl: z.string(),
  expiresAt: z.coerce.date(),
});

/** What a GitHub sign-in verified: the user, and the app's installations they reach. */
const signInCompletionSchema = z.looseObject({
  githubUser: z.object({ id: z.string(), login: z.string() }),
  installations: z.array(gitHubUserInstallationSchema.loose()),
});

/**
 * What finishing a sign-in did. `bound` installations serve the workspace, and `missing` names
 * the requested repositories they cannot reach. `install` sends the user to install the app on an
 * account where they reach no installation. A `conflict` installation serves another workspace.
 * `not-verified` is an installation GitHub's install redirect named but the user does not reach.
 */
export type GitHubSignInOutcome =
  | {
      kind: "bound";
      installation: { id: string; account: string; url: string };
      synced: boolean;
      linked: string[];
      missing: string[];
    }
  | { kind: "install"; account: string; installUrl: string }
  | {
      kind: "conflict";
      installation: { id: string; account: string; url: string };
      owner: GitHubInstallationOwner | null;
    }
  | { kind: "not-verified"; installationId: string }
  /** The installation is moving here from another workspace; the workflow says how it ended. */
  | {
      kind: "moving";
      installation: { id: string; account: string; url: string };
      instanceId: string;
    }
  | { kind: "failed"; message: string };

type Router = Pick<
  GitHubWebhookRouterCommands,
  | "consumeInstallState"
  | "storeInstallationClaimState"
  | "storeInstallationClaimCompletion"
  | "setInstallationOwner"
  | "getInstallationOwner"
  | "moveInstallationOwner"
  | "requestRepositoryInstall"
>;
type GitHub = Pick<GitHubCommands, "redeliverFailedInstallationWebhooks">;

function routeFailure(response: GitHubRouteResponse, fallback: string) {
  return response.type === "error" ? response.error.message : `${fallback} (${response.status}).`;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Where GitHub shows the installation's settings, such as which repositories it reaches. */
export function gitHubInstallationUrl(installation: GitHubUserInstallation) {
  if (installation.htmlUrl) {
    return installation.htmlUrl;
  }
  const id = encodeURIComponent(installation.id);
  return installation.accountType.toLowerCase() === "organization"
    ? `https://github.com/organizations/${encodeURIComponent(installation.accountLogin)}/settings/installations/${id}`
    : `https://github.com/settings/installations/${id}`;
}

/**
 * Starts a GitHub sign-in for `purpose` and returns where to send the user. GitHub returns them to
 * the OAuth callback, which finishes it with `finishGitHubSignIn`. An empty `returnTo` returns them
 * to the workspace's integrations.
 */
export async function startGitHubSignIn({
  router,
  callRoute,
  userId,
  owner,
  purpose,
  returnTo,
}: {
  router: Pick<Router, "storeInstallationClaimState">;
  callRoute: GitHubCallRoute;
  userId: string;
  owner: GitHubInstallationOwner;
  purpose: GitHubSignInPurpose;
  returnTo: string;
}): Promise<{ ok: true; authorizationUrl: string } | { ok: false; message: string }> {
  let response: GitHubRouteResponse;
  try {
    response = await callRoute("POST", "/oauth/start", {
      body: { subjectId: userId, ...(returnTo ? { returnTo } : {}) },
    });
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Failed to start GitHub sign-in.") };
  }
  if (!(response.type === "json" && isSuccessStatus(response.status))) {
    return { ok: false, message: routeFailure(response, "Failed to start GitHub sign-in") };
  }
  const { state, authorizationUrl, expiresAt } = signInStartSchema.parse(response.data);
  await router.storeInstallationClaimState({
    state,
    userId,
    owner,
    returnTo,
    expiresAt: expiresAt.getTime(),
    purpose,
    authorizationUrl,
  });
  return { ok: true, authorizationUrl };
}

/** Redirect notices the configuration page shows after GitHub returns from an install. */
export type GitHubInstallCallbackNotice =
  | "expired_state"
  | "user_mismatch"
  | "invalid_state"
  | "callback_error";

/**
 * Handles GitHub's install redirect. Its `installation_id` is only a claim anyone could make, so
 * the installation is bound once a GitHub sign-in shows the user reaches it: this returns that
 * sign-in, which links the repositories integration setup requested with the install.
 */
export async function completeGitHubInstallCallback({
  router,
  callRoute,
  userId,
  owner,
  state,
  installationId,
  returnTo,
}: {
  router: Pick<Router, "consumeInstallState" | "storeInstallationClaimState">;
  callRoute: GitHubCallRoute;
  userId: string;
  owner: GitHubInstallationOwner;
  state: string;
  installationId: string;
  returnTo: string;
}): Promise<{ kind: "sign-in"; authorizationUrl: string } | GitHubInstallCallbackNotice> {
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
  const signIn = await startGitHubSignIn({
    router,
    callRoute,
    userId,
    owner,
    purpose: { kind: "install", installationId, repositoryRequest: consumed.repositoryRequest },
    returnTo,
  });
  if (!signIn.ok) {
    console.error("GitHub install callback could not start the verifying sign-in", {
      owner: ownerSegment,
      installationId,
      error: signIn.message,
    });
    return "callback_error";
  }
  return { kind: "sign-in", authorizationUrl: signIn.authorizationUrl };
}

/**
 * Finishes the GitHub sign-in `state` names: verifies the user with GitHub's `code`, then does what
 * the sign-in was started for. A `choose` sign-in only records the installations to pick from.
 */
export async function finishGitHubSignIn({
  router,
  github,
  callRoute,
  userId,
  owner,
  purpose,
  state,
  code,
}: {
  router: Router;
  github: GitHub;
  callRoute: GitHubCallRoute;
  userId: string;
  owner: GitHubInstallationOwner;
  purpose: GitHubSignInPurpose;
  state: string;
  code: string;
}): Promise<{ kind: "choose" } | GitHubSignInOutcome> {
  let response: GitHubRouteResponse;
  try {
    response = await callRoute("POST", "/oauth/complete", {
      body: { subjectId: userId, state, code },
    });
  } catch (error) {
    return { kind: "failed", message: errorMessage(error, "Failed to verify GitHub access.") };
  }
  if (!(response.type === "json" && isSuccessStatus(response.status))) {
    return { kind: "failed", message: routeFailure(response, "Failed to verify GitHub access") };
  }
  // Kept whole: the picker shows every field GitHub listed.
  const completion = signInCompletionSchema.parse(response.data);
  if (purpose.kind === "choose") {
    await router.storeInstallationClaimCompletion({ state, userId, completion });
    return { kind: "choose" };
  }
  const outcome = await applySignIn({
    router,
    github,
    callRoute,
    userId,
    owner,
    purpose,
    completion,
  });
  await router.storeInstallationClaimCompletion({ state, userId, completion, outcome });
  return outcome;
}

async function applySignIn({
  router,
  github,
  callRoute,
  userId,
  owner,
  purpose,
  completion,
}: {
  router: Router;
  github: GitHub;
  callRoute: GitHubCallRoute;
  userId: string;
  owner: GitHubInstallationOwner;
  purpose: Exclude<GitHubSignInPurpose, { kind: "choose" }>;
  completion: z.output<typeof signInCompletionSchema>;
}): Promise<GitHubSignInOutcome> {
  if (purpose.kind === "install") {
    const installation = completion.installations.find(({ id }) => id === purpose.installationId);
    if (!installation) {
      console.warn("GitHub install callback named an installation the user does not reach", {
        owner: backofficeScopePathSegment(owner),
        installationId: purpose.installationId,
        githubUser: completion.githubUser.login,
      });
      return { kind: "not-verified", installationId: purpose.installationId };
    }
    return await bindGitHubInstallation({
      router,
      github,
      callRoute,
      owner,
      installation,
      repositories: purpose.repositoryRequest?.repositories ?? [],
    });
  }
  const account = purpose.request.owner.toLowerCase();
  const installation = completion.installations.find(
    ({ accountLogin }) => accountLogin.toLowerCase() === account,
  );
  if (installation) {
    return await bindGitHubInstallation({
      router,
      github,
      callRoute,
      owner,
      installation,
      repositories: purpose.request.repositories,
    });
  }
  return await requestInstall(router, userId, owner, purpose.request);
}

/** The user reaches no installation on the account, so GitHub's install page is next. */
async function requestInstall(
  router: Pick<Router, "requestRepositoryInstall">,
  userId: string,
  owner: GitHubInstallationOwner,
  request: GitHubRepositoryInstallRequest,
): Promise<GitHubSignInOutcome> {
  let installUrl: string | null = null;
  // One install link per account; each request adds its repository to it.
  for (const repository of request.repositories) {
    const requested = await router.requestRepositoryInstall(userId, owner, repository);
    if (!requested.ok) {
      return { kind: "failed", message: requested.message };
    }
    installUrl = requested.installUrl;
  }
  if (installUrl === null) {
    return { kind: "failed", message: "No repositories were requested." };
  }
  return { kind: "install", account: request.owner, installUrl };
}

/** The repositories a sign-in was started to link. */
export function signInRepositories(purpose: GitHubSignInPurpose): string[] {
  switch (purpose.kind) {
    case "choose":
      return [];
    case "install":
      return purpose.repositoryRequest?.repositories ?? [];
    case "repositories":
      return purpose.request.repositories;
    default:
      throw new Error("Unknown GitHub sign-in purpose.", { cause: purpose satisfies never });
  }
}

/** The installation as outcomes show it. */
export function describeGitHubInstallation(installation: GitHubUserInstallation) {
  return {
    id: installation.id,
    account: installation.accountLogin,
    url: gitHubInstallationUrl(installation),
  };
}

/** Why a GitHub route call failed, and whether another attempt may succeed. */
export type GitHubRouteFailure = { message: string; code: string | null; transient: boolean };

/**
 * Server failures and rate limits can pass, and so does a sync that another sync wrote ahead of;
 * any other refusal repeats until something changes.
 */
const transientFailure = (status: number, code: string | null) =>
  status >= 500 || status === 408 || status === 429 || code === "INSTALLATION_SYNC_CONFLICT";

async function callGitHubRoute(
  what: string,
  call: () => Promise<GitHubRouteResponse>,
): Promise<{ ok: true } | { ok: false; failure: GitHubRouteFailure }> {
  let response: GitHubRouteResponse;
  try {
    response = await call();
  } catch (error) {
    // The call did not reach the fragment, or did not come back.
    const message = `${what} failed: ${errorMessage(error, String(error))}`;
    return { ok: false, failure: { message, code: null, transient: true } };
  }
  if (response.type === "json" && isSuccessStatus(response.status)) {
    return { ok: true };
  }
  const code = response.type === "error" ? response.error.code : null;
  const reason = response.type === "error" ? response.error.message : `HTTP ${response.status}`;
  return {
    ok: false,
    failure: {
      message: `${what} failed: ${reason}`,
      code,
      transient: transientFailure(response.status, code),
    },
  };
}

/**
 * The version of a workspace's installation row, or `null` while it has none. A claim or release
 * reads it before checking which workspace the router names, and the fragment refuses the write
 * once the row changed. A move changes the router before it releases the old workspace, so a
 * release the check missed came after the read and changed the row, and the write conflicts;
 * reading and checking again sees the move.
 */
async function readInstallationVersion(
  callRoute: GitHubCallRoute,
  installationId: string,
): Promise<{ ok: true; version: number | null } | { ok: false; failure: GitHubRouteFailure }> {
  let version: number | null = null;
  const read = await callGitHubRoute("Reading the installation", async () => {
    const response = await callRoute("GET", "/installations/:installationId", {
      pathParams: { installationId },
    });
    if (response.type === "json") {
      version = response.data.version;
    }
    return response;
  });
  if (!read.ok && read.failure.code !== "INSTALLATION_NOT_FOUND") {
    return read;
  }
  return { ok: true, version };
}

const servesWorkspace = async (
  router: Pick<Router, "getInstallationOwner">,
  installationId: string,
  owner: GitHubInstallationOwner,
) => {
  const current = await router.getInstallationOwner(installationId);
  return current !== null && backofficeContextScopesEqual(current, owner);
};

/**
 * Forgets an installation in a workspace it no longer serves, which ends that workspace's
 * connections to its repositories; syncs there leave it released until it is bound there again.
 * Forgetting it again changes nothing, and once the installation serves the workspace again there
 * is nothing to forget. `INSTALLATION_SYNC_CONFLICT` means it changed meanwhile; release again.
 */
export async function releaseGitHubInstallation({
  router,
  callRoute,
  installation,
  owner,
}: {
  router: Pick<Router, "getInstallationOwner">;
  callRoute: GitHubCallRoute;
  installation: GitHubUserInstallation;
  owner: GitHubInstallationOwner;
}): Promise<GitHubRouteFailure | null> {
  const read = await readInstallationVersion(callRoute, installation.id);
  if (!read.ok) {
    return read.failure;
  }
  if (await servesWorkspace(router, installation.id, owner)) {
    return null;
  }
  const released = await callGitHubRoute("Releasing the installation", () =>
    callRoute("POST", "/installations/:installationId/release", {
      pathParams: { installationId: installation.id },
      body: {
        accountId: installation.accountId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        version: read.version,
      },
    }),
  );
  return released.ok ? null : released.failure;
}

/**
 * Reads the installation and the repositories it reaches from GitHub into the workspace it serves,
 * which claims it there even if the workspace released it before. It is not claimed once the
 * router names another workspace, and `INSTALLATION_SYNC_CONFLICT` means it changed meanwhile, as
 * a webhook's sync or a move away changes it; claim again.
 */
export async function claimGitHubInstallation({
  router,
  callRoute,
  installationId,
  owner,
}: {
  router: Pick<Router, "getInstallationOwner">;
  callRoute: GitHubCallRoute;
  installationId: string;
  owner: GitHubInstallationOwner;
}): Promise<
  | { kind: "claimed" }
  | { kind: "moved"; owner: GitHubInstallationOwner | null }
  | { kind: "failed"; failure: GitHubRouteFailure }
> {
  const read = await readInstallationVersion(callRoute, installationId);
  if (!read.ok) {
    return { kind: "failed", failure: read.failure };
  }
  if (!(await servesWorkspace(router, installationId, owner))) {
    return { kind: "moved", owner: await router.getInstallationOwner(installationId) };
  }
  const synced = await callGitHubRoute("Syncing the installation", () =>
    callRoute("POST", "/installations/:installationId/sync", {
      pathParams: { installationId },
      body: { claim: { version: read.version } },
    }),
  );
  return synced.ok ? { kind: "claimed" } : { kind: "failed", failure: synced.failure };
}

/**
 * Links a repository to the workspace; linking it again changes nothing. It is missing when the
 * installation cannot reach it: the user left it out on GitHub, or the installation is suspended.
 */
export async function linkGitHubRepository(
  callRoute: GitHubCallRoute,
  fullName: string,
): Promise<{ status: "linked" | "missing" } | { status: "failed"; failure: GitHubRouteFailure }> {
  const slash = fullName.indexOf("/");
  const linked = await callGitHubRoute(`Linking ${fullName}`, () =>
    callRoute("POST", "/repositories/:owner/:repo/link", {
      pathParams: { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) },
      body: {},
    }),
  );
  if (linked.ok) {
    return { status: "linked" };
  }
  const { code } = linked.failure;
  return code === "REPO_NOT_REACHABLE" || code === "INSTALLATION_INACTIVE"
    ? { status: "missing" }
    : { status: "failed", failure: linked.failure };
}

/**
 * Binds an installation the user was verified to reach to the workspace, syncs its repositories,
 * and links `repositories`. An installation already serving another workspace is a conflict.
 */
export async function bindGitHubInstallation({
  router,
  github,
  callRoute,
  owner,
  installation,
  repositories,
}: {
  router: Pick<Router, "setInstallationOwner" | "getInstallationOwner">;
  github: GitHub;
  callRoute: GitHubCallRoute;
  owner: GitHubInstallationOwner;
  installation: GitHubUserInstallation;
  repositories: readonly string[];
}): Promise<GitHubSignInOutcome> {
  const ownerSegment = backofficeScopePathSegment(owner);
  const described = describeGitHubInstallation(installation);
  const mapping = await router.setInstallationOwner(installation.id, owner);
  if (!mapping.ok) {
    if (mapping.code === "INSTALLATION_OWNER_CONFLICT") {
      return {
        kind: "conflict",
        installation: described,
        owner: await router.getInstallationOwner(installation.id),
      };
    }
    return { kind: "failed", message: mapping.message };
  }

  let syncFailure: GitHubRouteFailure | null = null;
  // A webhook's sync can write while this one reads GitHub; claiming again reads what it wrote.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const claimed = await claimGitHubInstallation({
      router,
      callRoute,
      installationId: installation.id,
      owner,
    });
    if (claimed.kind === "moved") {
      // A move took it to another workspace during the sign-in.
      return { kind: "conflict", installation: described, owner: claimed.owner };
    }
    syncFailure = claimed.kind === "failed" ? claimed.failure : null;
    if (syncFailure?.code !== "INSTALLATION_SYNC_CONFLICT") {
      break;
    }
  }
  // Webhooks GitHub sent before the installation was bound were refused; they are sent again.
  await github.redeliverFailedInstallationWebhooks(installation.id).catch((error: unknown) => {
    console.warn("GitHub installation webhook redelivery failed", {
      owner: ownerSegment,
      installationId: installation.id,
      error,
    });
  });
  if (syncFailure !== null) {
    console.warn("GitHub installation was bound but its sync failed", {
      owner: ownerSegment,
      installationId: installation.id,
      error: syncFailure.message,
    });
    // The redelivered webhooks sync it; setup links the repositories once they arrive.
    return {
      kind: "bound",
      installation: described,
      synced: false,
      linked: [],
      missing: [...repositories],
    };
  }

  const linked: string[] = [];
  const missing: string[] = [];
  for (const fullName of repositories) {
    const result = await linkGitHubRepository(callRoute, fullName);
    if (result.status === "failed") {
      // The installation is bound; linking again, as setup does, picks up where this stopped.
      return { kind: "failed", message: result.failure.message };
    }
    (result.status === "linked" ? linked : missing).push(fullName);
  }
  return { kind: "bound", installation: described, synced: true, linked, missing };
}
