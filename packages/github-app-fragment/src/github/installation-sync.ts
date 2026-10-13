import { type DatabaseRequestContext } from "@fragno-dev/db";

import { callService, type RepoId, type RepoLinkId } from "../routes/shared";
import type { GitHubInstallationDetails, GitHubInstallationRepository } from "./api";
import { hasRepoChanges, type InstallationRepoRow, toRepoRecord } from "./repo-sync";
import { installationLinkStatusChanges } from "./repository-links";
import type { GitHubAppFragmentServices } from "./services";
import { normalizeJoinedLinks, toExternalId } from "./utils";

export type InstallationSyncResult =
  | { ok: true; result: { added: number; removed: number; updated: number } }
  | {
      ok: false;
      code: "GITHUB_API_ERROR" | "INSTALLATION_NOT_FOUND";
      message: string;
      status: number;
    };

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
 * Mirrors GitHub's current installation and repositories. Reading GitHub instead of applying a
 * webhook payload makes the result independent of the order deliveries arrive in.
 */
export async function syncInstallationFromGitHub(
  handlerTx: DatabaseRequestContext["handlerTx"],
  services: GitHubAppFragmentServices,
  installationId: string,
  webhookReceivedAt: Date | null,
): Promise<InstallationSyncResult> {
  const { existingInstallation, existingRepos } = await callService(handlerTx, () =>
    services.getInstallationSyncState(installationId),
  );
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
      await callService(handlerTx, () =>
        services.applyInstallationSync({
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
        }),
      );
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

  await callService(handlerTx, () =>
    services.applyInstallationSync({
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
    }),
  );

  return { ok: true, result: { added, removed, updated } };
}
