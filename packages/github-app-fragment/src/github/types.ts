import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

import type { HookContext } from "@fragno-dev/db";

import type { EmitterWebhookEvent, EmitterWebhookEventName } from "@octokit/webhooks";

import type { GitHubRepositoryLinkStatusChangedPayload } from "./repository-links";

export type GitHubAppWebhookMeta = {
  deliveryId: string;
  event: string;
  action: string | null;
  installationId: string;
  hookId: string;
  receivedAt?: string | null;
};

export type GitHubAppWebhookHandler<TEventName extends EmitterWebhookEventName | "*"> = (
  event: TEventName extends "*"
    ? EmitterWebhookEvent
    : EmitterWebhookEvent<Extract<TEventName, EmitterWebhookEventName>>,
  idempotencyKey: string,
  meta: GitHubAppWebhookMeta,
) => void | Promise<void>;

export type GitHubAppWebhookOn = <TEventName extends EmitterWebhookEventName | "*">(
  event: TEventName | TEventName[],
  handler: GitHubAppWebhookHandler<TEventName>,
) => void;

export type GitHubAppWebhookConfig = (register: GitHubAppWebhookOn) => void;

export type GitHubAppFragmentConfig = {
  appId: string;
  appSlug: string;
  /** OAuth client id for this GitHub App. This is different from the numeric app id. */
  clientId: string;
  clientSecret: string;
  /** Exact callback URL registered on the GitHub App for user authorization. */
  callbackUrl: string;
  privateKeyPem: string;
  webhookSecret: string;
  webhookDebug?: boolean;
  apiBaseUrl?: string;
  apiVersion?: string;
  webBaseUrl?: string;
  defaultLinkKey?: string;
  tokenCacheTtlSeconds?: number;
  userAuthorizationStateTtlMs?: number;
  webhook?: GitHubAppWebhookConfig;
  /**
   * Fires when a repository link is created or removed, and when its installation becomes active
   * or stops being active, including repositories removed from the installation on GitHub.
   */
  onRepositoryLinkStatusChanged?: (
    payload: GitHubRepositoryLinkStatusChangedPayload,
    context: HookContext,
  ) => Promise<void> | void;
  /** Transport for GitHub REST and OAuth requests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
};

export type GitHubAppFragmentPublicClientConfig = FragnoPublicClientConfig;
