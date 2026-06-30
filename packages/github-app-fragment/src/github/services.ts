import type { TableToColumnValues } from "@fragno-dev/db/query";
import type { FragnoId } from "@fragno-dev/db/schema";

import { type DatabaseServiceContext, type TxResult } from "@fragno-dev/db";

import { githubAppSchema } from "../schema";
import { createGitHubApiClient, type GitHubInstallationDetails } from "./api";

export type GitHubAppFragmentDependencies = {
  githubApiClient: ReturnType<typeof createGitHubApiClient>;
};

type InstallationRow = TableToColumnValues<(typeof githubAppSchema)["tables"]["installation"]>;
type InstallationRepoRow = TableToColumnValues<
  (typeof githubAppSchema)["tables"]["installation_repo"]
>;
type RepoLinkRow = TableToColumnValues<(typeof githubAppSchema)["tables"]["repo_link"]>;
type InstallationId = string | FragnoId;
type RepoId = string | FragnoId;
type RepoLinkId = string | FragnoId;

export type GitHubInstallationSyncState = {
  existingInstallation: InstallationRow | null;
  existingRepos: Array<InstallationRepoRow & { links?: RepoLinkRow | RepoLinkRow[] | null }>;
};

export type GitHubInstallationRepoUpdate = {
  id: RepoId;
  data: Partial<
    Omit<
      {
        installationId: string;
        ownerLogin: string;
        name: string;
        fullName: string;
        isPrivate: boolean;
        isFork?: boolean;
        defaultBranch?: string | null;
        removedAt: Date | null;
        updatedAt: Date;
      },
      "id"
    >
  >;
};

export type GitHubInstallationSyncMutation = {
  existingInstallationId: InstallationId | null;
  installationDetails: GitHubInstallationDetails;
  now: Date;
  creates: Array<{
    id: string;
    installationId: string;
    ownerLogin: string;
    name: string;
    fullName: string;
    isPrivate: boolean;
    isFork?: boolean;
    defaultBranch?: string | null;
    removedAt: Date | null;
    updatedAt: Date;
  }>;
  updates: GitHubInstallationRepoUpdate[];
  removals: RepoId[];
  linksToDelete: RepoLinkId[];
};

export type GitHubAppFragmentServices = {
  app: ReturnType<typeof createGitHubApiClient>["app"];
  githubApiClient: ReturnType<typeof createGitHubApiClient>;
  getInstallationSyncState(installationId: string): TxResult<GitHubInstallationSyncState>;
  applyInstallationSync(input: GitHubInstallationSyncMutation): TxResult<void>;
};

const toInstallationSyncUpdate = (
  installation: GitHubInstallationDetails,
  now: Date,
): Partial<Omit<InstallationRow, "id" | "createdAt" | "lastWebhookAt">> => ({
  accountId: installation.accountId,
  accountLogin: installation.accountLogin,
  accountType: installation.accountType,
  status: installation.status,
  permissions: installation.permissions,
  events: installation.events,
  updatedAt: now,
});

export const createGitHubServices = (
  deps: GitHubAppFragmentDependencies,
  defineService: <T>(svc: T & ThisType<DatabaseServiceContext<{}>>) => T,
): GitHubAppFragmentServices =>
  defineService({
    app: deps.githubApiClient.app,
    githubApiClient: deps.githubApiClient,
    getInstallationSyncState(installationId: string) {
      return this.serviceTx(githubAppSchema)
        .retrieve((uow) =>
          uow
            .findFirst("installation", (b) =>
              b.whereIndex("uniq_installation_id", (eb) => eb("id", "=", installationId)),
            )
            .find("installation_repo", (b) =>
              b
                .whereIndex("idx_installation_repo_installation", (eb) =>
                  eb("installationId", "=", installationId),
                )
                .joinMany("links", "repo_link", (link) =>
                  link.onIndex("uniq_repo_link_repo_id_link_key", (eb) =>
                    eb("repoId", "=", eb.parent("id")),
                  ),
                ),
            ),
        )
        .transformRetrieve(
          ([existingInstallation, existingRepos]): GitHubInstallationSyncState => ({
            existingInstallation,
            existingRepos,
          }),
        )
        .build();
    },
    applyInstallationSync(input: GitHubInstallationSyncMutation) {
      return this.serviceTx(githubAppSchema)
        .mutate(({ uow }) => {
          if (input.existingInstallationId) {
            uow.update("installation", input.existingInstallationId, (b) =>
              b.set(toInstallationSyncUpdate(input.installationDetails, input.now)),
            );
          } else {
            uow.create("installation", {
              id: input.installationDetails.id,
              accountId: input.installationDetails.accountId,
              accountLogin: input.installationDetails.accountLogin,
              accountType: input.installationDetails.accountType,
              status: input.installationDetails.status,
              permissions: input.installationDetails.permissions,
              events: input.installationDetails.events,
            });
          }

          for (const record of input.creates) {
            uow.create("installation_repo", record);
          }
          for (const update of input.updates) {
            uow.update("installation_repo", update.id, (b) => b.set(update.data));
          }
          for (const id of input.removals) {
            uow.update("installation_repo", id, (b) =>
              b.set({ removedAt: input.now, updatedAt: input.now }),
            );
          }
          for (const id of input.linksToDelete) {
            uow.delete("repo_link", id);
          }
        })
        .build();
    },
  });
