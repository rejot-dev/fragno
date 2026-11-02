import { ConcurrencyConflictError, type DatabaseRequestContext } from "@fragno-dev/db";

import { callService, type RepoId, type RepoLinkId } from "../routes/shared";
import type { GitHubInstallationDetails, GitHubInstallationRepository } from "./api";
import { hasRepoChanges, type InstallationRepoRow, toRepoRecord } from "./repo-sync";
import { installationLinkStatusChanges } from "./repository-links";
import type { GitHubAppFragmentServices, GitHubInstallationAccount } from "./services";
import { normalizeJoinedLinks, toExternalId } from "./utils";

export type InstallationSyncResult =
  | { ok: true; result: { added: number; removed: number; updated: number } }
  | {
      ok: false;
      code: "GITHUB_API_ERROR" | "INSTALLATION_NOT_FOUND";
      message: string;
      status: number;
    }
  | InstallationSyncConflict
  | InstallationReleased;

/** The installation serves another store, so a sync here changes nothing until one claims it. */
export type InstallationReleased = {
  ok: false;
  code: "INSTALLATION_RELEASED";
  message: string;
  status: 409;
};

const installationReleased: InstallationReleased = {
  ok: false,
  code: "INSTALLATION_RELEASED",
  message: "The installation was released to serve another workspace.",
  status: 409,
};

/** Another sync of the installation wrote first; syncing again reads what it wrote. */
export type InstallationSyncConflict = {
  ok: false;
  code: "INSTALLATION_SYNC_CONFLICT";
  message: string;
  status: 409;
};

const syncConflict: InstallationSyncConflict = {
  ok: false,
  code: "INSTALLATION_SYNC_CONFLICT",
  message: "The installation changed while it was synced; sync it again.",
  status: 409,
};

/**
 * Writes what a sync read, unless another sync of the installation wrote after this one read. A
 * sync waits on GitHub between reading and writing, and another one, such as a webhook's, can run
 * meanwhile; the write then conflicts, and the caller syncs again.
 */
async function writeInstallationSync(
  handlerTx: DatabaseRequestContext["handlerTx"],
  services: GitHubAppFragmentServices,
  input: Parameters<GitHubAppFragmentServices["applyInstallationSync"]>[0],
): Promise<{ ok: true } | InstallationSyncConflict> {
  try {
    await callService(handlerTx, () => services.applyInstallationSync(input));
    return { ok: true };
  } catch (error) {
    if (error instanceof ConcurrencyConflictError) {
      return syncConflict;
    }
    throw error;
  }
}

function getHttpStatusCode(value: unknown): number | null {
  if (typeof value === "object" && value && "status" in value) {
    const status = (value as { status?: unknown }).status;
    if (typeof status === "number" && Number.isFinite(status)) {
      return status;
    }
  }
  return null;
}

function githubApiError(err: unknown): InstallationSyncResult {
  return {
    ok: false,
    code: "GITHUB_API_ERROR",
    message: err instanceof Error ? err.message : "GitHub API request failed.",
    status: 502,
  };
}

/**
 * What a store's installation row was when the caller read it: its version, or `null` while the
 * store has none. A claim or release names it, and only writes over that row.
 */
export type InstallationFence = { version: number | null };

const versionOf = (installation: { id: { version: number } } | null): number | null =>
  installation?.id.version ?? null;

/**
 * Mirrors GitHub's current installation and repositories. Reading GitHub instead of applying a
 * webhook payload makes the result independent of the order deliveries arrive in.
 *
 * GitHub still reports a released installation, which serves another store, as active; only a sync
 * that `claim`s it, because it serves this store again, mirrors it. Any other sync, such as one a
 * delivery queued before the release prompts, leaves it released. A claim names the row the caller
 * read before it confirmed the installation serves this store, and conflicts once the row changed,
 * so a claim confirmed before a later release cannot undo it.
 */
export async function syncInstallationFromGitHub(
  handlerTx: DatabaseRequestContext["handlerTx"],
  services: GitHubAppFragmentServices,
  installationId: string,
  {
    webhookReceivedAt,
    claim,
  }: {
    webhookReceivedAt: Date | null;
    claim: InstallationFence | null;
  },
): Promise<InstallationSyncResult> {
  const { existingInstallation, existingRepos } = await callService(handlerTx, () =>
    services.getInstallationSyncState(installationId),
  );
  if (claim) {
    if (versionOf(existingInstallation) !== claim.version) {
      return syncConflict;
    }
  } else if (existingInstallation?.releasedAt != null) {
    return installationReleased;
  }
  const now = new Date();

  let installationDetails: GitHubInstallationDetails;
  try {
    installationDetails = await services.githubApiClient.getInstallation(installationId);
  } catch (err) {
    if (getHttpStatusCode(err) !== 404) {
      return githubApiError(err);
    }
    // GitHub answers 404 for an installation it deleted; stored repositories keep their history.
    if (existingInstallation && existingInstallation.status !== "deleted") {
      const written = await writeInstallationSync(handlerTx, services, {
        installation: { kind: "deleted", existingInstallationId: existingInstallation.id },
        now,
        webhookReceivedAt,
        creates: [],
        updates: [],
        removals: [],
        linksToDelete: [],
        linkStatusChanges: installationLinkStatusChanges({
          previousInstallationStatus: existingInstallation.status,
          nextInstallationStatus: "deleted",
          repos: existingRepos,
          removedRepoIds: new Set(),
        }),
      });
      if (!written.ok) {
        return written;
      }
    }
    return {
      ok: false,
      code: "INSTALLATION_NOT_FOUND",
      message: "Installation not found.",
      status: 404,
    };
  }

  // GitHub issues no installation tokens while suspended, so its repositories keep their state.
  let repos: GitHubInstallationRepository[] | null = null;
  if (installationDetails.status === "active") {
    try {
      repos = (await services.githubApiClient.listInstallationRepos(installationId)).repositories;
    } catch (err) {
      return githubApiError(err);
    }
  }

  let added = 0;
  let updated = 0;
  let removed = 0;

  type RepoUpdateData = Omit<ReturnType<typeof toRepoRecord>, "id">;
  const creates: Array<ReturnType<typeof toRepoRecord>> = [];
  const updates: Array<{ id: RepoId; data: Partial<RepoUpdateData> }> = [];
  const removals: Array<RepoId> = [];
  const removedRepoIds = new Set<string>();
  const linksToDelete: Array<RepoLinkId> = [];

  if (repos) {
    const existingById = new Map<string, InstallationRepoRow & { links?: unknown }>();
    for (const repo of existingRepos) {
      existingById.set(toExternalId(repo.id), repo);
    }
    const seen = new Set<string>();

    for (const repo of repos) {
      const record = toRepoRecord(installationId, repo, now);
      seen.add(record.id);
      const existing = existingById.get(record.id);

      if (!existing) {
        added += 1;
        creates.push(record);
        continue;
      }

      if (hasRepoChanges(existing, record)) {
        updated += 1;
        updates.push({
          id: existing.id,
          data: {
            installationId: record.installationId,
            ownerLogin: record.ownerLogin,
            name: record.name,
            fullName: record.fullName,
            isPrivate: record.isPrivate,
            ...(record.isFork !== undefined ? { isFork: record.isFork } : {}),
            ...(record.defaultBranch !== undefined ? { defaultBranch: record.defaultBranch } : {}),
            removedAt: null,
            updatedAt: now,
          },
        });
      }
    }

    for (const repo of existingRepos) {
      const repoId = toExternalId(repo.id);
      if (seen.has(repoId) || repo.removedAt !== null) {
        continue;
      }
      removed += 1;
      removals.push(repo.id);
      removedRepoIds.add(repoId);
      for (const link of normalizeJoinedLinks(repo.links)) {
        linksToDelete.push(link.id);
      }
    }
  }

  const written = await writeInstallationSync(handlerTx, services, {
    installation: {
      kind: "current",
      existingInstallationId: existingInstallation?.id ?? null,
      details: installationDetails,
    },
    now,
    webhookReceivedAt,
    creates,
    updates,
    removals,
    linksToDelete,
    linkStatusChanges: installationLinkStatusChanges({
      previousInstallationStatus: existingInstallation?.status ?? null,
      nextInstallationStatus: installationDetails.status,
      repos: existingRepos,
      removedRepoIds,
    }),
  });
  if (!written.ok) {
    return written;
  }

  return { ok: true, result: { added, removed, updated } };
}

/**
 * Forgets an installation that now serves another store: it counts as deleted here, and its
 * repositories and their links are removed, so nothing here reaches it anymore. GitHub keeps the
 * installation. It stays released, also through syncs that deliveries queued before now prompt,
 * until a sync claims it; an installation this store never synced is recorded released, so a later
 * sync cannot add it either. Returns whether it was not released already.
 *
 * The release names the row the caller read before it confirmed the installation serves another
 * store, and conflicts once the row changed, so a late release cannot undo a later claim. It writes
 * the row even when it was released already, which makes a claim confirmed before this release,
 * such as one for an earlier move here, conflict.
 */
export async function releaseInstallation(
  handlerTx: DatabaseRequestContext["handlerTx"],
  services: GitHubAppFragmentServices,
  account: GitHubInstallationAccount,
  fence: InstallationFence,
): Promise<{ ok: true; released: boolean } | InstallationSyncConflict> {
  const { existingInstallation, existingRepos } = await callService(handlerTx, () =>
    services.getInstallationSyncState(account.installationId),
  );
  if (versionOf(existingInstallation) !== fence.version) {
    return syncConflict;
  }
  const current = existingRepos.filter((repo) => repo.removedAt === null);
  const written = await writeInstallationSync(handlerTx, services, {
    installation: {
      kind: "released",
      existingInstallationId: existingInstallation?.id ?? null,
      account,
    },
    now: new Date(),
    webhookReceivedAt: null,
    creates: [],
    updates: [],
    removals: current.map((repo) => repo.id),
    linksToDelete: current.flatMap((repo) => normalizeJoinedLinks(repo.links).map(({ id }) => id)),
    linkStatusChanges: installationLinkStatusChanges({
      previousInstallationStatus: existingInstallation?.status ?? null,
      nextInstallationStatus: "deleted",
      repos: current,
      removedRepoIds: new Set(current.map((repo) => toExternalId(repo.id))),
    }),
  });
  if (!written.ok) {
    return written;
  }
  return { ok: true, released: existingInstallation?.releasedAt == null };
}
