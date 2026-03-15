import type { TableToColumnValues } from "@fragno-dev/db/query";

import { githubAppSchema } from "../schema";
import type { GitHubInstallationRepository } from "./api";

export type InstallationRepoRow = TableToColumnValues<
  (typeof githubAppSchema)["tables"]["installation_repo"]
>;

export type RepoRecord = {
  id: string;
  installationId: string;
  ownerLogin: string;
  name: string;
  fullName: string;
  isPrivate: boolean;
  isFork?: boolean;
  defaultBranch?: string | null;
  removedAt: null;
  updatedAt: Date;
};

export type RepoCreateRecord = Omit<RepoRecord, "isFork" | "defaultBranch"> & {
  isFork: boolean | null;
  defaultBranch: string | null;
};

export const toRepoRecord = (
  installationId: string,
  repo: GitHubInstallationRepository,
  now: Date,
): RepoRecord => {
  const ownerLogin = repo.owner?.login ?? "";
  const record: RepoRecord = {
    id: `${repo.id}`,
    installationId,
    ownerLogin,
    name: repo.name,
    fullName: repo.full_name ?? `${ownerLogin}/${repo.name}`,
    isPrivate: Boolean(repo.private),
    removedAt: null,
    updatedAt: now,
  };

  if (repo.fork !== undefined) {
    record.isFork = Boolean(repo.fork);
  }
  if (repo.default_branch !== undefined) {
    record.defaultBranch = repo.default_branch ?? null;
  }

  return record;
};

export const toRepoCreateRecord = (record: RepoRecord): RepoCreateRecord => ({
  ...record,
  isFork: record.isFork ?? null,
  defaultBranch: record.defaultBranch ?? null,
});

export const hasRepoChanges = (existing: InstallationRepoRow, record: RepoRecord) => {
  const forkChanged = typeof record.isFork === "boolean" && existing.isFork !== record.isFork;
  const defaultBranchChanged =
    record.defaultBranch !== undefined && (existing.defaultBranch ?? null) !== record.defaultBranch;

  return (
    existing.ownerLogin !== record.ownerLogin ||
    existing.name !== record.name ||
    existing.fullName !== record.fullName ||
    existing.isPrivate !== record.isPrivate ||
    forkChanged ||
    defaultBranchChanged ||
    existing.installationId == null ||
    existing.removedAt !== null
  );
};
