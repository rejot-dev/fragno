import {
  createGitHubAppFragment,
  type GitHubAppWebhookMeta,
  type GitHubAppFragmentConfig,
} from "@fragno-dev/github-app-fragment";

import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";

import { AUTOMATION_SYSTEM_ACTOR, type AutomationEvent } from "./automation/contracts";

export type GitHubConfig = Pick<
  GitHubAppFragmentConfig,
  | "appId"
  | "appSlug"
  | "clientId"
  | "clientSecret"
  | "callbackUrl"
  | "privateKeyPem"
  | "webhookSecret"
  | "webhookDebug"
  | "apiBaseUrl"
  | "apiVersion"
  | "webBaseUrl"
  | "defaultLinkKey"
  | "tokenCacheTtlSeconds"
  | "webhook"
>;

export function createGitHubServer(
  config: GitHubConfig,
  runtime: BackofficeFragmentRuntimeOptions,
): ReturnType<typeof createGitHubAppFragment> {
  return createGitHubAppFragment(config, {
    databaseAdapter: runtime.adapters.createAdapter({
      kind: "github",
    }),
    mountRoute: "/api/github",
  });
}

export type GitHubFragment = ReturnType<typeof createGitHubServer>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const toStringValue = (value: unknown) => {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
};

const pickRecord = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null;

const githubActor = (payload: Record<string, unknown>, installationId: string) => {
  const sender = pickRecord(payload.sender);
  const senderId = toStringValue(sender?.id);
  if (sender && senderId) {
    return {
      scope: "external" as const,
      source: "github",
      type: "user",
      id: senderId,
      login: toStringValue(sender.login) || undefined,
      role: "initiator",
    };
  }

  if (installationId) {
    return {
      scope: "external" as const,
      source: "github",
      type: "installation",
      id: installationId,
      role: "initiator",
    };
  }

  return AUTOMATION_SYSTEM_ACTOR;
};

const githubSubject = (
  orgId: string,
  payload: Record<string, unknown>,
  meta: GitHubAppWebhookMeta,
) => {
  const repository = pickRecord(payload.repository);
  const installation = pickRecord(payload.installation);
  const account = pickRecord(installation?.account);
  const issue = pickRecord(payload.issue);
  const pullRequest = pickRecord(payload.pull_request);

  return {
    orgId,
    installationId: meta.installationId,
    ...(account
      ? {
          accountId: toStringValue(account.id),
          accountLogin: toStringValue(account.login) || toStringValue(account.slug),
        }
      : {}),
    ...(repository
      ? {
          repositoryId: toStringValue(repository.id),
          repositoryFullName: toStringValue(repository.full_name),
        }
      : {}),
    ...(issue ? { issueNumber: toStringValue(issue.number) } : {}),
    ...(pullRequest ? { pullRequestNumber: toStringValue(pullRequest.number) } : {}),
  };
};

export const buildGitHubAutomationEvent = ({
  orgId,
  event,
  meta,
}: {
  orgId: string;
  event: { name: string; payload: unknown };
  meta: GitHubAppWebhookMeta;
}): AutomationEvent => {
  const payload = isRecord(event.payload) ? event.payload : {};
  const action = meta.action;
  const actor = githubActor(payload, meta.installationId);

  return {
    id: meta.hookId,
    scope: { kind: "org", orgId },
    source: "github",
    eventType: "webhook.received",
    occurredAt: meta.receivedAt ?? new Date().toISOString(),
    payload: {
      deliveryId: meta.deliveryId,
      githubEvent: event.name,
      action,
      installationId: meta.installationId,
      sender: payload.sender ?? null,
      repository: payload.repository ?? null,
      issue: payload.issue ?? null,
      pullRequest: payload.pull_request ?? null,
      raw: payload,
    },
    actor,
    actors: [actor],
    subject: githubSubject(orgId, payload, meta),
  };
};
