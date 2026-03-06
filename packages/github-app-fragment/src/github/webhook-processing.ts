import type { HookContext } from "@fragno-dev/db";
import type { TableToColumnValues } from "@fragno-dev/db/query";
import type { EmitterWebhookEvent } from "@octokit/webhooks";

import type { GitHubInstallationRepository } from "./api";
import {
  hasRepoChanges,
  type InstallationRepoRow,
  toRepoCreateRecord,
  toRepoRecord,
} from "./repo-sync";
import { githubAppSchema } from "../schema";
import { normalizeJoinedLinks, toExternalId } from "./utils";

type InstallationRow = TableToColumnValues<(typeof githubAppSchema)["tables"]["installation"]>;
type RepoLinkRow = TableToColumnValues<(typeof githubAppSchema)["tables"]["repo_link"]>;
type InstallationRepoId = InstallationRepoRow["id"];
type RepoLinkId = RepoLinkRow["id"];

type GitHubWebhookPayload<TEventName extends EmitterWebhookEvent["name"]> = Extract<
  EmitterWebhookEvent,
  { name: TEventName }
>["payload"];

type InstallationPayload = GitHubWebhookPayload<"installation">;
type InstallationRepositoriesPayload = GitHubWebhookPayload<"installation_repositories">;

/** Single discriminated union for supported events. One cast at entry derives all typed data. */
type SupportedWebhook =
  | { event: "installation"; action: string | null; payload: InstallationPayload }
  | {
      event: "installation_repositories";
      action: string | null;
      payload: InstallationRepositoriesPayload;
    };

export type WebhookProcessingPayload = {
  deliveryId: string;
  event: string;
  action: string | null;
  installationId: string;
  payload: Record<string, unknown>;
  receivedAt?: string | null;
};

const SUPPORTED_EVENTS = ["installation", "installation_repositories"] as const;

function asSupportedWebhook(data: WebhookProcessingPayload): SupportedWebhook | null {
  if (!SUPPORTED_EVENTS.includes(data.event as (typeof SUPPORTED_EVENTS)[number])) {
    return null;
  }
  return data as unknown as SupportedWebhook;
}

type WebhookRepoSnapshot =
  | NonNullable<InstallationPayload["repositories"]>[number]
  | InstallationRepositoriesPayload["repositories_added"][number];

const normalizeInstallationStatus = (action: string | null) => {
  switch (action) {
    case "created":
    case "new_permissions_accepted":
    case "unsuspend":
      return "active";
    case "suspend":
      return "suspended";
    case "deleted":
      return "deleted";
    default:
      return null;
  }
};

const resolveReceivedAt = (receivedAt?: string | null) => {
  if (!receivedAt) {
    return new Date();
  }
  const parsed = new Date(receivedAt);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

const parseOwnerLoginFromFullName = (fullName: string) => {
  const separatorIndex = fullName.indexOf("/");
  if (separatorIndex <= 0) {
    return "";
  }
  return fullName.slice(0, separatorIndex);
};

// Webhook repo snapshots can omit `fork` and `default_branch`.
// Leave them unset so updates do not overwrite previously synced values.
const toInstallationRepoFromWebhookRepository = (
  repo: WebhookRepoSnapshot,
): GitHubInstallationRepository => {
  const ownerLogin = parseOwnerLoginFromFullName(repo.full_name);
  const mapped: GitHubInstallationRepository = {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    private: repo.private,
    owner: { login: ownerLogin },
  };
  if ("fork" in repo && typeof repo.fork === "boolean") {
    mapped.fork = repo.fork;
  }
  if ("default_branch" in repo) {
    const defaultBranch = repo.default_branch;
    if (typeof defaultBranch === "string" || defaultBranch === null) {
      mapped.default_branch = defaultBranch;
    }
  }
  return mapped;
};

function extractAccountFromInstallation(
  installation: NonNullable<SupportedWebhook["payload"]["installation"]>,
) {
  const account = installation.account;
  if (!account) {
    throw new Error("Webhook payload installation missing account");
  }
  const accountId = `${account.id}`;
  if ("login" in account) {
    return { accountId, accountLogin: account.login, accountType: account.type ?? "" };
  }
  return { accountId, accountLogin: account.slug, accountType: "Enterprise" };
}

const isRepoSyncAction = (action: string | null) => {
  return action === "created" || action === "new_permissions_accepted";
};

type RepoUpdateData = Omit<ReturnType<typeof toRepoRecord>, "id">;

const toRepoUpdateData = (
  record: ReturnType<typeof toRepoRecord>,
  now: Date,
): Partial<RepoUpdateData> => ({
  installationId: record.installationId,
  ownerLogin: record.ownerLogin,
  name: record.name,
  fullName: record.fullName,
  isPrivate: record.isPrivate,
  ...(record.isFork !== undefined ? { isFork: record.isFork } : {}),
  ...(record.defaultBranch !== undefined ? { defaultBranch: record.defaultBranch } : {}),
  removedAt: null,
  updatedAt: now,
});

export const createWebhookProcessor = () => {
  return async function processWebhook(this: HookContext, data: WebhookProcessingPayload) {
    const webhook = asSupportedWebhook(data);
    if (!webhook) {
      return;
    }

    const { event, action, payload } = webhook;
    const now = resolveReceivedAt(data.receivedAt);
    const installationId = data.installationId;

    const installation = payload.installation;
    if (!installation) {
      throw new Error("Webhook payload missing installation (required for installation events)");
    }
    const { accountId, accountLogin, accountType } = extractAccountFromInstallation(installation);

    const statusOverride = normalizeInstallationStatus(action);
    const needsRepoSync =
      event === "installation_repositories" ||
      (event === "installation" && isRepoSyncAction(action));

    let existingInstallation: InstallationRow | null = null;
    let existingRepos: Array<InstallationRepoRow & { links?: RepoLinkRow | RepoLinkRow[] }> = [];

    if (needsRepoSync) {
      [existingInstallation, existingRepos] = await this.handlerTx()
        .retrieve(({ forSchema }) => {
          const uow = forSchema(githubAppSchema);
          return uow
            .findFirst("installation", (b) =>
              b.whereIndex("uniq_installation_id", (eb) => eb("id", "=", installationId)),
            )
            .find("installation_repo", (b) =>
              b
                .whereIndex("idx_installation_repo_installation", (eb) =>
                  eb("installationId", "=", installationId),
                )
                .join((jb) => jb.links()),
            );
        })
        .execute();
    } else {
      [existingInstallation] = await this.handlerTx()
        .retrieve(({ forSchema }) => {
          const uow = forSchema(githubAppSchema);
          return uow.findFirst("installation", (b) =>
            b.whereIndex("uniq_installation_id", (eb) => eb("id", "=", installationId)),
          );
        })
        .execute();
    }

    const existingStatus =
      existingInstallation && typeof existingInstallation.status === "string"
        ? existingInstallation.status
        : null;
    const installationUpdate = {
      accountId,
      accountLogin,
      accountType,
      status: statusOverride || existingStatus || "active",
      permissions: installation.permissions ?? existingInstallation?.permissions ?? null,
      events: installation.events ?? existingInstallation?.events ?? null,
      updatedAt: now,
      lastWebhookAt: now,
    };

    const creates: Array<ReturnType<typeof toRepoRecord>> = [];
    const updates: Array<{ id: InstallationRepoId; data: Partial<RepoUpdateData> }> = [];
    const removals: Array<InstallationRepoId> = [];
    const linksToDelete: Array<RepoLinkId> = [];

    if (needsRepoSync) {
      const existingById = new Map<string, InstallationRepoRow>();
      for (const repo of existingRepos) {
        const id = toExternalId(repo.id);
        if (id) {
          existingById.set(id, repo);
        }
      }

      const repoLinksByRepoId = new Map<string, RepoLinkRow[]>();
      for (const repo of existingRepos) {
        const repoId = toExternalId(repo.id);
        if (!repoId) {
          continue;
        }
        const linkEntries = normalizeJoinedLinks(repo.links);
        if (linkEntries.length === 0) {
          continue;
        }
        repoLinksByRepoId.set(repoId, linkEntries);
      }

      if (event === "installation") {
        // `repositories` is optional in the webhook payload — absent means no repos
        // were selected during installation, not that the data was truncated.
        const repos = (payload.repositories ?? []).map(toInstallationRepoFromWebhookRepository);
        const seen = new Set<string>();

        for (const repo of repos) {
          const record = toRepoRecord(installationId, repo, now);
          seen.add(record.id);
          const existing = existingById.get(record.id);

          if (!existing) {
            creates.push(record);
            continue;
          }

          if (hasRepoChanges(existing, record)) {
            updates.push({ id: existing.id, data: toRepoUpdateData(record, now) });
          }
        }

        for (const [repoId, repo] of existingById.entries()) {
          if (seen.has(repoId)) {
            continue;
          }
          if (repo.removedAt === null) {
            removals.push(repo.id);
            const links = repoLinksByRepoId.get(repoId);
            if (links) {
              for (const link of links) {
                linksToDelete.push(link.id);
              }
            }
          }
        }
      }

      if (event === "installation_repositories") {
        const added = payload.repositories_added;
        const removed = payload.repositories_removed;

        for (const repo of added) {
          const record = toRepoRecord(
            installationId,
            toInstallationRepoFromWebhookRepository(repo),
            now,
          );
          const existing = existingById.get(record.id);

          if (!existing) {
            creates.push(record);
            continue;
          }

          if (hasRepoChanges(existing, record)) {
            updates.push({ id: existing.id, data: toRepoUpdateData(record, now) });
          }
        }

        for (const repo of removed) {
          const repoId = toExternalId(repo.id) || null;
          if (!repoId) {
            continue;
          }
          const existing = existingById.get(repoId);
          if (existing && existing.removedAt === null) {
            removals.push(existing.id);
            const links = repoLinksByRepoId.get(repoId);
            if (links) {
              for (const link of links) {
                linksToDelete.push(link.id);
              }
            }
          }
        }
      }
    }

    const hasRepoMutations =
      creates.length > 0 || updates.length > 0 || removals.length > 0 || linksToDelete.length > 0;

    await this.handlerTx()
      .mutate(({ forSchema }) => {
        const uow = forSchema(githubAppSchema);

        if (existingInstallation) {
          uow.update("installation", installationId, (b) => b.set(installationUpdate));
        } else {
          uow.create("installation", {
            id: installationId,
            accountId: installationUpdate.accountId,
            accountLogin: installationUpdate.accountLogin,
            accountType: installationUpdate.accountType,
            status: installationUpdate.status,
            permissions: installationUpdate.permissions,
            events: installationUpdate.events,
            createdAt: now,
            updatedAt: now,
            lastWebhookAt: now,
          });
        }

        if (hasRepoMutations) {
          for (const record of creates) {
            uow.create("installation_repo", toRepoCreateRecord(record));
          }

          for (const update of updates) {
            uow.update("installation_repo", update.id, (b) => b.set(update.data));
          }

          for (const id of removals) {
            uow.update("installation_repo", id, (b) => b.set({ removedAt: now, updatedAt: now }));
          }

          for (const id of linksToDelete) {
            uow.delete("repo_link", id);
          }
        }
      })
      .execute();
  };
};
