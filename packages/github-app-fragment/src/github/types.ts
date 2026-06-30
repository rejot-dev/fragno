import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

import type { EmitterWebhookEvent, EmitterWebhookEventName } from "@octokit/webhooks";

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
};

export type GitHubAppFragmentPublicClientConfig = FragnoPublicClientConfig;
