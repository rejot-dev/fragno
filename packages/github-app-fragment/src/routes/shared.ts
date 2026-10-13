import type { TableToColumnValues } from "@fragno-dev/db/query";
import { FragnoId } from "@fragno-dev/db/schema";
import { z } from "zod";

import { type DatabaseRequestContext, type TxResult } from "@fragno-dev/db";

import type { GitHubUserInstallation } from "../github/api";
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

/** Link key used when neither the request nor `defaultLinkKey` names one. */
export const GITHUB_APP_FALLBACK_LINK_KEY = "default";

export const normalizeLinkKey = (linkKey: string | null | undefined, defaultLinkKey?: string) => {
  const normalized = linkKey?.trim();
  return normalized && normalized.length > 0
    ? normalized
    : (defaultLinkKey ?? GITHUB_APP_FALLBACK_LINK_KEY);
};

export const parseLinkedOnly = (value: string | null) => value === "true" || value === "1";

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
