import type { TableToColumnValues } from "@fragno-dev/db/query";
import { FragnoId } from "@fragno-dev/db/schema";
import { z } from "zod";

import { type DatabaseRequestContext, type TxResult } from "@fragno-dev/db";

import type {
  GitHubApiClient,
  GitHubInstallationDetails,
  GitHubInstallationRepository,
  GitHubUserInstallation,
} from "../github/api";
import type { GitHubAppFragmentServices } from "../github/definition";
import { hasRepoChanges, toRepoRecord } from "../github/repo-sync";
import {
  isRecord,
  normalizeJoinedInstallation,
  normalizeJoinedLinks,
  toExternalId,
  toStringValue,
} from "../github/utils";
import { githubAppSchema } from "../schema";

export { isRecord, normalizeJoinedInstallation, normalizeJoinedLinks, toExternalId, toStringValue };

export type InstallationRepoRow = TableToColumnValues<
  (typeof githubAppSchema)["tables"]["installation_repo"]
>;
export type RepoLinkRow = TableToColumnValues<(typeof githubAppSchema)["tables"]["repo_link"]>;
export type RepoId = string | FragnoId;
export type RepoLinkId = string | FragnoId;

export type OAuthStateRecord = {
  id: string | FragnoId;
  subjectId: string;
  returnTo?: string | null;
  installations?: unknown;
  githubUserId?: string | null;
  githubLogin?: string | null;
  createdAt: Date;
  expiresAt: Date;
  completedAt?: Date | null;
};

export type InstallationSyncResult =
  | { ok: true; result: { added: number; removed: number; updated: number } }
  | {
      ok: false;
      code: "GITHUB_API_ERROR" | "INSTALLATION_NOT_FOUND";
      message: string;
      status: number;
    };

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

export const createOAuthState = () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
};

export const toDebugSignature = (signatureHeader: string | null) => {
  if (!signatureHeader) {
    return null;
  }
  if (signatureHeader.length <= 20) {
    return signatureHeader;
  }
  return `${signatureHeader.slice(0, 12)}…${signatureHeader.slice(-8)}`;
};

export const normalizeLinkKey = (linkKey: string | null | undefined, defaultLinkKey?: string) => {
  const normalized = linkKey?.trim();
  return normalized && normalized.length > 0 ? normalized : (defaultLinkKey ?? "default");
};

export const parseLinkedOnly = (value: string | null) => value === "true" || value === "1";

const getHttpStatusCode = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "object" && value && "status" in value) {
    const status = (value as { status?: unknown }).status;
    if (typeof status === "number" && Number.isFinite(status)) {
      return status;
    }
  }
  return null;
};

export const callService = async <T, TRetrieve>(
  handlerTx: DatabaseRequestContext["handlerTx"],
  call: () => TxResult<T, TRetrieve>,
): Promise<T> => {
  const result = await handlerTx()
    .withServiceCalls(() => [call()] as const)
    .transform(({ serviceResult: [serviceResult] }) => serviceResult)
    .execute();
  return result as T;
};

export const syncInstallationFromGitHub = async (
  handlerTx: DatabaseRequestContext["handlerTx"],
  services: GitHubAppFragmentServices,
  api: GitHubApiClient,
  installationId: string,
): Promise<InstallationSyncResult> => {
  const { existingInstallation, existingRepos } = await callService(handlerTx, () =>
    services.getInstallationSyncState(installationId),
  );

  let installationDetails: GitHubInstallationDetails;
  try {
    installationDetails = await api.getInstallation(installationId);
  } catch (err) {
    if (getHttpStatusCode(err) === 404) {
      return {
        ok: false,
        code: "INSTALLATION_NOT_FOUND",
        message: "Installation not found.",
        status: 404,
      };
    }
    return {
      ok: false,
      code: "GITHUB_API_ERROR",
      message: err instanceof Error ? err.message : "GitHub API request failed.",
      status: 502,
    };
  }

  let response: { repositories: GitHubInstallationRepository[] };
  try {
    response = await api.listInstallationRepos(installationId);
  } catch (err) {
    return {
      ok: false,
      code: "GITHUB_API_ERROR",
      message: err instanceof Error ? err.message : "GitHub API request failed.",
      status: 502,
    };
  }

  const repos = response.repositories ?? [];
  const now = new Date();
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

  let added = 0;
  let updated = 0;
  let removed = 0;

  type RepoUpdateData = Omit<ReturnType<typeof toRepoRecord>, "id">;
  const creates: Array<ReturnType<typeof toRepoRecord>> = [];
  const updates: Array<{ id: RepoId; data: Partial<RepoUpdateData> }> = [];
  const removals: Array<RepoId> = [];
  const linksToDelete: Array<RepoLinkId> = [];
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
        id: existing.id as RepoId,
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

  for (const [repoId, repo] of existingById.entries()) {
    if (seen.has(repoId)) {
      continue;
    }
    if (repo.removedAt === null) {
      removed += 1;
      removals.push(repo.id as RepoId);
      const links = repoLinksByRepoId.get(repoId);
      if (links) {
        for (const link of links) {
          linksToDelete.push(link.id as RepoLinkId);
        }
      }
    }
  }

  await callService(handlerTx, () =>
    services.applyInstallationSync({
      existingInstallationId: existingInstallation?.id ?? null,
      installationDetails,
      now,
      creates,
      updates,
      removals,
      linksToDelete,
    }),
  );

  return { ok: true, result: { added, removed, updated } };
};

export const installationOutputSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  accountLogin: z.string(),
  accountType: z.string(),
  status: z.string(),
  permissions: z.any(),
  events: z.any(),
  createdAt: z.date(),
  updatedAt: z.date(),
  lastWebhookAt: z.date().nullable(),
});

export const repoSummarySchema = z.object({
  id: z.string(),
  installationId: z.string(),
  ownerLogin: z.string(),
  name: z.string(),
  fullName: z.string(),
  isPrivate: z.boolean(),
  isFork: z.boolean().nullable(),
  defaultBranch: z.string().nullable(),
  removedAt: z.date().nullable(),
  updatedAt: z.date(),
});

export const repoWithLinksSchema = repoSummarySchema.extend({
  linkKeys: z.array(z.string()),
});

export const repoLinkOutputSchema = z.object({
  repoId: z.string(),
  linkKey: z.string(),
  linkedAt: z.date(),
});

export const oauthInstallationSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  accountLogin: z.string(),
  accountType: z.string(),
  appId: z.string(),
  appSlug: z.string(),
  repositorySelection: z.string(),
  permissions: z.any(),
  events: z.any(),
  htmlUrl: z.string().nullable(),
  status: z.string(),
});

export const oauthStartOutputSchema = z.object({
  authorizationUrl: z.string(),
  state: z.string(),
  expiresAt: z.date(),
});

export const oauthCompleteOutputSchema = z.object({
  state: z.string(),
  subjectId: z.string(),
  githubUser: z.object({ id: z.string(), login: z.string() }),
  installations: z.array(oauthInstallationSchema),
  returnTo: z.string().nullable(),
  expiresAt: z.date(),
});

export const toOAuthInstallation = (installation: GitHubUserInstallation) => ({
  id: installation.id,
  accountId: installation.accountId,
  accountLogin: installation.accountLogin,
  accountType: installation.accountType,
  appId: installation.appId,
  appSlug: installation.appSlug,
  repositorySelection: installation.repositorySelection,
  permissions: installation.permissions,
  events: installation.events,
  htmlUrl: installation.htmlUrl,
  status: installation.status,
});
