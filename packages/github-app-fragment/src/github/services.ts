import type { TableToColumnValues } from "@fragno-dev/db/query";
import type { FragnoId } from "@fragno-dev/db/schema";

import { type DatabaseServiceContext, type TxResult } from "@fragno-dev/db";

import { githubAppSchema } from "../schema";
import { createGitHubApiClient, type GitHubInstallationDetails } from "./api";
import type { GitHubAppHooksMap } from "./definition";
import type { GitHubRepositoryLinkStatusChangedPayload } from "./repository-links";

export type GitHubAppFragmentDependencies = {
  githubApiClient: ReturnType<typeof createGitHubApiClient>;
  /** `config.webhookDeliveryRetentionMs`, checked to be a positive whole number. */
  webhookDeliveryRetentionMs: number;
};

type InstallationRow = TableToColumnValues<(typeof githubAppSchema)["tables"]["installation"]>;
type InstallationRepoRow = TableToColumnValues<
  (typeof githubAppSchema)["tables"]["installation_repo"]
>;
type RepoLinkRow = TableToColumnValues<(typeof githubAppSchema)["tables"]["repo_link"]>;
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
  /** GitHub's current installation, or the deletion of one GitHub no longer has. */
  installation:
    | {
        kind: "current";
        existingInstallationId: FragnoId | null;
        details: GitHubInstallationDetails;
      }
    | { kind: "deleted"; existingInstallationId: FragnoId }
    /** The installation now serves another store; recorded even if this one never synced it. */
    | {
        kind: "released";
        existingInstallationId: FragnoId | null;
        account: GitHubInstallationAccount;
      };
  now: Date;
  /** When a webhook delivery prompted the sync, which records it as the latest delivery. */
  webhookReceivedAt: Date | null;
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
  linkStatusChanges: GitHubRepositoryLinkStatusChangedPayload[];
};

/** The GitHub account an installation belongs to. */
export type GitHubInstallationAccount = {
  installationId: string;
  accountId: string;
  accountLogin: string;
  accountType: string;
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
  // Only a sync that claims a released installation reaches one, and it serves this store again.
  releasedAt: null,
  updatedAt: now,
});

export const createGitHubServices = (
  deps: GitHubAppFragmentDependencies,
  defineService: <T>(svc: T & ThisType<DatabaseServiceContext<GitHubAppHooksMap>>) => T,
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
          const { installation, webhookReceivedAt } = input;
          const delivery = webhookReceivedAt ? { lastWebhookAt: webhookReceivedAt } : {};
          // Another sync can write between this one's read and write. A stale update fails its
          // check, and creating a row it created fails as the same conflict, so the caller syncs
          // again with a fresh read.
          const created = { retryOnUniqueConflict: () => true };
          switch (installation.kind) {
            case "current":
              if (installation.existingInstallationId) {
                uow.update("installation", installation.existingInstallationId, (b) =>
                  b
                    .set({
                      ...toInstallationSyncUpdate(installation.details, input.now),
                      ...delivery,
                    })
                    .check(),
                );
              } else {
                uow.create(
                  "installation",
                  {
                    id: installation.details.id,
                    accountId: installation.details.accountId,
                    accountLogin: installation.details.accountLogin,
                    accountType: installation.details.accountType,
                    status: installation.details.status,
                    permissions: installation.details.permissions,
                    events: installation.details.events,
                    lastWebhookAt: webhookReceivedAt,
                  },
                  created,
                );
              }
              break;
            case "deleted":
              uow.update("installation", installation.existingInstallationId, (b) =>
                b.set({ status: "deleted", updatedAt: input.now, ...delivery }).check(),
              );
              break;
            case "released":
              if (installation.existingInstallationId) {
                uow.update("installation", installation.existingInstallationId, (b) =>
                  b.set({ status: "deleted", releasedAt: input.now, updatedAt: input.now }).check(),
                );
              } else {
                // A sync that read no row then conflicts with this one, and reads it released.
                const { account } = installation;
                uow.create(
                  "installation",
                  {
                    id: account.installationId,
                    accountId: account.accountId,
                    accountLogin: account.accountLogin,
                    accountType: account.accountType,
                    status: "deleted",
                    permissions: {},
                    events: [],
                    releasedAt: input.now,
                  },
                  created,
                );
              }
              break;
            default:
              throw new Error("Unknown installation sync.", {
                cause: installation satisfies never,
              });
          }

          for (const record of input.creates) {
            uow.create("installation_repo", record, created);
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
          for (const change of input.linkStatusChanges) {
            uow.triggerHook("onRepositoryLinkStatusChanged", change);
          }
        })
        .build();
    },
  });
