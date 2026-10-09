import { normalizeJoinedLinks, toExternalId } from "./utils";

/** A link is active while it exists and its installation is active. */
export type GitHubRepositoryLinkStatus = "active" | "inactive" | "unlinked";

export interface GitHubRepositoryLinkStatusChangedPayload {
  linkKey: string;
  repositoryId: string;
  fullName: string;
  status: GitHubRepositoryLinkStatus;
}

/**
 * Link changes caused by an installation update: removed repositories lose their links, and links
 * on remaining repositories follow the installation when it becomes active or stops being active.
 */
export function installationLinkStatusChanges(args: {
  previousInstallationStatus: string | null;
  nextInstallationStatus: string;
  repos: ReadonlyArray<{
    id: unknown;
    fullName: string;
    removedAt: Date | null;
    links?: { linkKey: string } | { linkKey: string }[] | null;
  }>;
  removedRepoIds: ReadonlySet<string>;
}): GitHubRepositoryLinkStatusChangedPayload[] {
  const wasActive = args.previousInstallationStatus === "active";
  const isActive = args.nextInstallationStatus === "active";
  return args.repos.flatMap((repo) => {
    const repositoryId = toExternalId(repo.id);
    let status: GitHubRepositoryLinkStatus;
    if (args.removedRepoIds.has(repositoryId)) {
      status = "unlinked";
    } else if (repo.removedAt === null && wasActive !== isActive) {
      status = isActive ? "active" : "inactive";
    } else {
      return [];
    }
    return normalizeJoinedLinks(repo.links).map((link) => ({
      linkKey: link.linkKey,
      repositoryId,
      fullName: repo.fullName,
      status,
    }));
  });
}
